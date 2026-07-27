import type { Component, Terminal, TUI } from '@moonshot-ai/pi-tui';

import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import { TasksBrowserApp, type TasksFilter } from '../components/dialogs/tasks-browser';
import type { Theme } from '#/tui/theme';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { AgentTask, SessionAgentControlPort } from '../runtime/session-control-port';
import type { TUISessionRuntime } from '../runtime/tui-session-runtime';

type TasksBrowserRuntime = Pick<TUISessionRuntime, 'sessionId'> & {
  readonly agent: Pick<
    SessionAgentControlPort,
    'listTasks' | 'getTaskOutput' | 'stopTask'
  >;
};

export interface TasksBrowserHost {
  readonly state: {
    readonly tasksBrowser: TasksBrowserState | undefined;
    readonly theme: Theme;
    readonly terminal: Terminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
  };
  readonly backgroundTasks: ReadonlyMap<string, AgentTask>;
  requireSessionRuntime(): TasksBrowserRuntime;
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
}

export type TasksBrowserState = {
  component: TasksBrowserApp;
  savedChildren: readonly Component[];
  tasks: readonly AgentTask[];
  filter: TasksFilter;
  selectedTaskId: string | undefined;
  tailOutput: string | undefined;
  tailLoading: boolean;
  tailRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  runtime: TasksBrowserRuntime;
  sessionId: string;
  viewer:
    | {
        component: TaskOutputViewer;
        savedChildren: readonly Component[];
        taskId: string;
        output: string;
        refreshId: number;
        pollTimer: NodeJS.Timeout;
      }
    | undefined;
};

export class TasksBrowserController {
  constructor(private readonly host: TasksBrowserHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.tasksBrowser !== undefined) return;

    let runtime: TasksBrowserRuntime;
    try {
      runtime = this.host.requireSessionRuntime();
    } catch {
      this.host.showError('No active session.');
      return;
    }
    const { sessionId } = runtime;

    let tasks: readonly AgentTask[] = [];
    try {
      tasks = await runtime.agent.listTasks({ activeOnly: false });
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, sessionId)) return;
      this.host.showError(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!this.isCurrentRuntime(runtime, sessionId) || state.tasksBrowser !== undefined) return;

    const filter: TasksFilter = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, filter);
    const component = new TasksBrowserApp(
      {
        tasks,
        filter,
        selectedTaskId,
        tailOutput: undefined,
        tailLoading: false,
        flashMessage: undefined,
        ...this.buildCallbacks(),
      },
      state.terminal,
    );

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowser({
      component,
      savedChildren,
      tasks,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      runtime,
      sessionId,
      viewer: undefined,
    });

    if (selectedTaskId !== undefined) {
      this.loadTail(selectedTaskId);
    }
  }

  close(): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) this.closeOutputViewer();
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

    state.ui.clear();
    for (const child of browser.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setTasksBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  repaint(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (!this.isCurrentRuntime(browser.runtime, browser.sessionId)) return;
    const tasks = new Map(browser.tasks.map((task) => [task.taskId, task]));
    for (const task of this.host.backgroundTasks.values()) {
      tasks.set(task.taskId, task);
    }
    this.pushProps([...tasks.values()]);
  }

  async refreshOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;

    const { runtime, sessionId } = browser;
    if (!this.isCurrentRuntime(runtime, sessionId)) return;

    const myRefreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await runtime.agent.getTaskOutput(viewer.taskId);
    } catch (error) {
      if (
        !this.isCurrentRuntime(runtime, sessionId) ||
        state.tasksBrowser !== browser ||
        state.tasksBrowser.viewer !== viewer
      ) {
        return;
      }
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flash(`Output refresh failed: ${message}`);
      }
      return;
    }
    const current = state.tasksBrowser?.viewer;
    if (
      !this.isCurrentRuntime(runtime, sessionId) ||
      current === undefined ||
      current !== viewer ||
      current.refreshId !== myRefreshId
    ) {
      return;
    }
    if (output === viewer.output) return;
    viewer.output = output;
    const info =
      this.host.backgroundTasks.get(viewer.taskId) ??
      browser.tasks.find((task) => task.taskId === viewer.taskId);
    viewer.component.setProps({
      taskId: viewer.taskId,
      info,
      output,
      onClose: () => {
        this.closeOutputViewer();
      },
    });
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------

  private pickInitialSelection(
    tasks: readonly AgentTask[],
    filter: TasksFilter,
  ): string | undefined {
    const candidates =
      filter === 'all'
        ? tasks
        : tasks.filter(
            (t) =>
              t.status !== 'completed' &&
              t.status !== 'failed' &&
              t.status !== 'timed_out' &&
              t.status !== 'killed' &&
              t.status !== 'lost',
          );
    if (candidates.length === 0) return undefined;
    return candidates.find((t) => t.status === 'running')?.taskId ?? candidates[0]!.taskId;
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const { runtime, sessionId } = browser;
    if (!this.isCurrentRuntime(runtime, sessionId)) return;

    let tasks: readonly AgentTask[];
    try {
      tasks = await runtime.agent.listTasks({ activeOnly: false });
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, sessionId)) return;
      if (!opts.silent) {
        this.flash(
          `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (
      !this.isCurrentRuntime(runtime, sessionId) ||
      state.tasksBrowser !== browser
    ) {
      return;
    }
    this.pushProps(tasks);
  }

  private pushProps(tasks: readonly AgentTask[]): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (!this.isCurrentRuntime(browser.runtime, browser.sessionId)) return;
    browser.tasks = tasks;
    browser.component.setProps({
      tasks,
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      tailOutput: browser.tailOutput,
      tailLoading: browser.tailLoading,
      flashMessage: browser.flashMessage,
      ...this.buildCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  private buildCallbacks(): {
    onSelect: (taskId: string) => void;
    onToggleFilter: () => void;
    onRefresh: () => void;
    onCancel: () => void;
    onStopConfirmed: (taskId: string) => void;
    onOpenOutput: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        this.handleSelect(taskId);
      },
      onToggleFilter: () => {
        this.handleToggleFilter();
      },
      onRefresh: () => {
        this.handleRefresh();
      },
      onCancel: () => {
        this.close();
      },
      onStopConfirmed: (taskId) => {
        void this.handleStop(taskId);
      },
      onOpenOutput: (taskId) => {
        void this.handleOpenOutput(taskId);
      },
      onStopIgnored: (taskId, reason) => {
        if (reason === 'terminal') {
          this.flash(`${taskId} is already terminal — nothing to stop.`);
        }
      },
    };
  }

  private handleSelect(taskId: string): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (!this.isCurrentRuntime(browser.runtime, browser.sessionId)) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.tailOutput = undefined;
    browser.tailLoading = true;
    this.repaint();
    this.loadTail(taskId);
  }

  private handleToggleFilter(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (!this.isCurrentRuntime(browser.runtime, browser.sessionId)) return;
    browser.filter = browser.filter === 'all' ? 'active' : 'all';
    this.repaint();
  }

  private handleRefresh(): void {
    const browser = this.host.state.tasksBrowser;
    if (
      browser === undefined ||
      !this.isCurrentRuntime(browser.runtime, browser.sessionId)
    ) {
      return;
    }
    this.flash('Refreshing…', 600);
    void this.refresh();
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;

    const { runtime, sessionId } = browser;
    if (!this.isCurrentRuntime(runtime, sessionId)) return;

    this.flash(`Stopping ${taskId}…`, 1500);
    try {
      await runtime.agent.stopTask(taskId, 'User initiated stop');
      if (
        !this.isCurrentRuntime(runtime, sessionId) ||
        this.host.state.tasksBrowser !== browser
      ) {
        return;
      }
      await this.refresh({ silent: true });
    } catch (error) {
      if (
        !this.isCurrentRuntime(runtime, sessionId) ||
        this.host.state.tasksBrowser !== browser
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.flash(`Stop failed: ${message}`);
    }
  }

  private async handleOpenOutput(taskId: string): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) return;

    const { runtime, sessionId } = browser;
    if (!this.isCurrentRuntime(runtime, sessionId)) return;

    let output: string;
    try {
      output = await runtime.agent.getTaskOutput(taskId);
    } catch (error) {
      if (
        !this.isCurrentRuntime(runtime, sessionId) ||
        state.tasksBrowser !== browser
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.flash(`Cannot open output: ${message}`);
      return;
    }
    const current = state.tasksBrowser;
    if (
      !this.isCurrentRuntime(runtime, sessionId) ||
      current === undefined ||
      current !== browser
    ) {
      return;
    }

    const info =
      this.host.backgroundTasks.get(taskId) ??
      browser.tasks.find((task) => task.taskId === taskId);
    const viewer = new TaskOutputViewer(
      {
        taskId,
        info,
        output,
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );

    const savedBrowserChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer({ silent: true });
    }, 1000);

    browser.viewer = {
      component: viewer,
      savedChildren: savedBrowserChildren,
      taskId,
      output,
      refreshId: 0,
      pollTimer,
    };
  }

  private loadTail(taskId: string): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const { runtime, sessionId } = browser;
    if (!this.isCurrentRuntime(runtime, sessionId)) return;

    const requestId = ++browser.tailRequestId;
    void runtime.agent
      .getTaskOutput(taskId, 4000)
      .then((output) => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (!this.isCurrentRuntime(runtime, sessionId)) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = output;
        current.tailLoading = false;
        this.pushProps(current.tasks);
      })
      .catch(() => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (!this.isCurrentRuntime(runtime, sessionId)) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = '';
        current.tailLoading = false;
        this.pushProps(current.tasks);
      });
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (!this.isCurrentRuntime(browser.runtime, browser.sessionId)) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.host.state.tasksBrowser;
      if (current !== browser) return;
      if (!this.isCurrentRuntime(browser.runtime, browser.sessionId)) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.pushProps(current.tasks);
    }, durationMs);
    this.pushProps(browser.tasks);
  }

  private closeOutputViewer(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    clearInterval(viewer.pollTimer);
    browser.viewer = undefined;
    this.host.state.ui.clear();
    for (const child of viewer.savedChildren) {
      this.host.state.ui.addChild(child);
    }
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestRender(true);
  }

  private isCurrentRuntime(runtime: TasksBrowserRuntime, sessionId: string): boolean {
    try {
      const current = this.host.requireSessionRuntime();
      return current === runtime && current.sessionId === sessionId;
    } catch {
      return false;
    }
  }
}
