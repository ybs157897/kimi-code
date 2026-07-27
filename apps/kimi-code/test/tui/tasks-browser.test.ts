/**
 * Scenarios: task-browser runtime routing plus dialog rendering and input.
 * Responsibilities: list/poll/tail/open/stop behavior, stale-session isolation,
 * detached filtering, and keyboard interaction. The runtime agent is the only
 * stubbed boundary. Run with:
 * pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/tasks-browser.test.ts
 */

import { TUI, type Terminal } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '@/tui/components/editor/custom-editor';
import {
  TasksBrowserApp,
  type TasksBrowserProps,
  type TasksFilter,
} from '@/tui/components/dialogs/tasks-browser';
import {
  TasksBrowserController,
  type TasksBrowserHost,
  type TasksBrowserState,
} from '@/tui/controllers/tasks-browser';
import type {
  AgentTask,
  AgentTaskListInput,
  AgentTaskStatus,
} from '@/tui/runtime/session-control-port';
import { currentTheme } from '@/tui/theme';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/** Minimal Terminal stub — only `rows` is read by the component. */
function fakeTerminal(rows: number, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: 'bash-abcd1234',
    kind: 'process',
    command: 'npm run dev',
    description: 'dev server',
    status: 'running',
    pid: 1234,
    exitCode: null,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    ...overrides,
  };
}

function makeProps(overrides: Partial<TasksBrowserProps> = {}): TasksBrowserProps {
  return {
    tasks: [],
    filter: 'all',
    selectedTaskId: undefined,
    tailOutput: undefined,
    tailLoading: false,
    flashMessage: undefined,
    onSelect: vi.fn(),
    onToggleFilter: vi.fn(),
    onRefresh: vi.fn(),
    onCancel: vi.fn(),
    onStopConfirmed: vi.fn(),
    onOpenOutput: vi.fn(),
    onStopIgnored: vi.fn(),
    ...overrides,
  } as TasksBrowserProps;
}

function makeApp(
  props: Partial<TasksBrowserProps> = {},
  rows = 30,
  columns = 120,
): TasksBrowserApp {
  return new TasksBrowserApp(makeProps(props), fakeTerminal(rows, columns));
}

type TasksRuntime = ReturnType<TasksBrowserHost['requireSessionRuntime']>;

function runtimeRig(options: {
  readonly sessionId?: string;
  readonly tasks?: readonly AgentTask[];
  readonly output?: string;
} = {}) {
  const listTasks = vi.fn(
    async (_input?: AgentTaskListInput): Promise<readonly AgentTask[]> =>
      options.tasks ?? [],
  );
  const getTaskOutput = vi.fn(
    async (_taskId: string, _tail?: number): Promise<string> => options.output ?? '',
  );
  const stopTask = vi.fn(async (_taskId: string, _reason?: string): Promise<void> => {});
  const runtime = {
    sessionId: options.sessionId ?? 'session-a',
    agent: { listTasks, getTaskOutput, stopTask },
  } satisfies TasksRuntime;
  return { runtime, listTasks, getTaskOutput, stopTask };
}

interface ControllerRig {
  readonly controller: TasksBrowserController;
  readonly errors: string[];
  readonly ui: TUI;
  readonly editor: CustomEditor;
  setRuntime(runtime: TasksRuntime): void;
  getBrowser(): TasksBrowserState | undefined;
}

const controllerRigs: ControllerRig[] = [];

function controllerRig(initialRuntime: TasksRuntime): ControllerRig {
  const terminal = fakeTerminal(30);
  const ui = new TUI(terminal);
  const editor = new CustomEditor(ui, { disablePasteBurst: false });
  const backgroundTasks = new Map<string, AgentTask>();
  const errors: string[] = [];
  let activeRuntime = initialRuntime;
  let browser: TasksBrowserState | undefined;

  ui.addChild(editor);
  ui.setFocus(editor);

  const host: TasksBrowserHost = {
    state: {
      get tasksBrowser() {
        return browser;
      },
      theme: currentTheme,
      terminal,
      ui,
      editor,
    },
    backgroundTasks,
    requireSessionRuntime: () => activeRuntime,
    showError: (message) => {
      errors.push(message);
    },
    setTasksBrowser: (value) => {
      browser = value;
    },
  };
  const controller = new TasksBrowserController(host);
  const rig: ControllerRig = {
    controller,
    errors,
    ui,
    editor,
    setRuntime: (runtime) => {
      activeRuntime = runtime;
    },
    getBrowser: () => browser,
  };
  controllerRigs.push(rig);
  return rig;
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}

afterEach(() => {
  for (const rig of controllerRigs.splice(0)) {
    rig.controller.close();
  }
  vi.restoreAllMocks();
});

describe('TasksBrowserController — runtime task operations', () => {
  it('lists all runtime tasks when the browser opens', async () => {
    const runtime = runtimeRig({
      tasks: [task({ taskId: 'bash-runtime', detached: true })],
    });
    const rig = controllerRig(runtime.runtime);

    await rig.controller.show();

    expect(runtime.listTasks).toHaveBeenCalledWith({ activeOnly: false });
    expect(strip(rig.getBrowser()!.component.render(120).join('\n'))).toContain(
      'bash-runtime',
    );
  });

  it('refreshes the visible list when the registered poll runs', async () => {
    const runtime = runtimeRig();
    runtime.listTasks
      .mockResolvedValueOnce([task({ taskId: 'bash-initial', detached: true })])
      .mockResolvedValueOnce([task({ taskId: 'bash-polled', detached: true })]);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const rig = controllerRig(runtime.runtime);

    await rig.controller.show();
    const poll = intervalSpy.mock.calls[0]?.[0];
    if (typeof poll !== 'function') throw new Error('task poll was not registered');
    poll();
    await settlePromises();

    expect(strip(rig.getBrowser()!.component.render(120).join('\n'))).toContain(
      'bash-polled',
    );
  });

  it('loads a bounded output tail for the initially selected task', async () => {
    const runtime = runtimeRig({
      tasks: [task({ taskId: 'bash-tail', detached: true })],
      output: 'tail output',
    });
    const rig = controllerRig(runtime.runtime);

    await rig.controller.show();
    await settlePromises();

    expect(runtime.getTaskOutput).toHaveBeenCalledWith('bash-tail', 4000);
    expect(strip(rig.getBrowser()!.component.render(120).join('\n'))).toContain(
      'tail output',
    );
  });

  it('opens the output viewer with the complete runtime output', async () => {
    const runtime = runtimeRig({
      tasks: [task({ taskId: 'bash-output', detached: true })],
    });
    runtime.getTaskOutput.mockImplementation(
      async (_taskId: string, tail?: number): Promise<string> =>
        tail === undefined ? 'complete output' : 'tail output',
    );
    const rig = controllerRig(runtime.runtime);

    await rig.controller.show();
    await settlePromises();
    rig.getBrowser()!.component.handleInput('o');
    await settlePromises();

    expect(runtime.getTaskOutput).toHaveBeenNthCalledWith(2, 'bash-output');
    expect(strip(rig.ui.children[0]!.render(120).join('\n'))).toContain(
      'complete output',
    );
  });

  it('stops the selected task through the runtime agent after confirmation', async () => {
    const runtime = runtimeRig({
      tasks: [task({ taskId: 'bash-stop', detached: true })],
    });
    const rig = controllerRig(runtime.runtime);

    await rig.controller.show();
    rig.getBrowser()!.component.handleInput('s');
    rig.getBrowser()!.component.handleInput('y');
    await settlePromises();

    expect(runtime.stopTask).toHaveBeenCalledWith(
      'bash-stop',
      'User initiated stop',
    );
  });

  it('reports the runtime list error when opening fails', async () => {
    const runtime = runtimeRig();
    runtime.listTasks.mockRejectedValueOnce(new Error('list unavailable'));
    const rig = controllerRig(runtime.runtime);

    await rig.controller.show();

    expect(rig.errors).toEqual(['Failed to load tasks: list unavailable']);
    expect(rig.getBrowser()).toBeUndefined();
  });

  it('does not mount stale list results after the active runtime switches', async () => {
    const pending = deferred<readonly AgentTask[]>();
    const first = runtimeRig({ sessionId: 'session-a' });
    first.listTasks.mockImplementationOnce(() => pending.promise);
    const second = runtimeRig({ sessionId: 'session-b' });
    const rig = controllerRig(first.runtime);

    const showing = rig.controller.show();
    rig.setRuntime(second.runtime);
    pending.resolve([task({ taskId: 'bash-stale', detached: true })]);
    await showing;

    expect(rig.getBrowser()).toBeUndefined();
    expect(rig.ui.children).toEqual([rig.editor]);
  });

  it('does not apply a pending refresh after the active runtime switches', async () => {
    const pending = deferred<readonly AgentTask[]>();
    const first = runtimeRig({
      sessionId: 'session-a',
      tasks: [task({ taskId: 'bash-current', detached: true })],
    });
    const second = runtimeRig({ sessionId: 'session-b' });
    const rig = controllerRig(first.runtime);

    await rig.controller.show();
    first.listTasks.mockImplementationOnce(() => pending.promise);
    rig.getBrowser()!.component.handleInput('r');
    rig.setRuntime(second.runtime);
    pending.resolve([task({ taskId: 'bash-stale', detached: true })]);
    await settlePromises();

    const rendered = strip(rig.getBrowser()!.component.render(120).join('\n'));
    expect(rendered).toContain('bash-current');
    expect(rendered).not.toContain('bash-stale');
  });

  it('does not apply pending tail output after the active runtime switches', async () => {
    const pending = deferred<string>();
    const first = runtimeRig({
      sessionId: 'session-a',
      tasks: [task({ taskId: 'bash-current', detached: true })],
    });
    first.getTaskOutput.mockImplementationOnce(() => pending.promise);
    const second = runtimeRig({ sessionId: 'session-b' });
    const rig = controllerRig(first.runtime);

    await rig.controller.show();
    rig.setRuntime(second.runtime);
    pending.resolve('stale tail');
    await settlePromises();

    expect(rig.getBrowser()!.tailOutput).toBeUndefined();
  });

  it('does not open a viewer after the active runtime switches', async () => {
    const pending = deferred<string>();
    const first = runtimeRig({
      sessionId: 'session-a',
      tasks: [task({ taskId: 'bash-current', detached: true })],
      output: 'tail output',
    });
    first.getTaskOutput
      .mockResolvedValueOnce('tail output')
      .mockImplementationOnce(() => pending.promise);
    const second = runtimeRig({ sessionId: 'session-b' });
    const rig = controllerRig(first.runtime);

    await rig.controller.show();
    await settlePromises();
    rig.getBrowser()!.component.handleInput('o');
    rig.setRuntime(second.runtime);
    pending.resolve('stale complete output');
    await settlePromises();

    expect(rig.getBrowser()!.viewer).toBeUndefined();
  });

  it('does not refresh the old browser after a stop completes in another runtime', async () => {
    const pending = deferred<void>();
    const first = runtimeRig({
      sessionId: 'session-a',
      tasks: [task({ taskId: 'bash-current', detached: true })],
    });
    first.stopTask.mockImplementationOnce(() => pending.promise);
    const second = runtimeRig({ sessionId: 'session-b' });
    const rig = controllerRig(first.runtime);

    await rig.controller.show();
    rig.getBrowser()!.component.handleInput('s');
    rig.getBrowser()!.component.handleInput('y');
    rig.setRuntime(second.runtime);
    pending.resolve(undefined);
    await settlePromises();

    expect(first.listTasks).toHaveBeenCalledTimes(1);
  });
});

describe('TasksBrowserApp — full-screen rendering', () => {
  it('fills exactly terminal.rows lines (height takeover)', () => {
    const rows = 30;
    const lines = makeApp({}, rows).render(120);
    expect(lines.length).toBe(rows);
  });

  it('reacts to terminal height changes', () => {
    const props = makeProps({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    // Two terminals with different heights — verify render adapts.
    const small = new TasksBrowserApp(props, fakeTerminal(15, 120)).render(120);
    const big = new TasksBrowserApp(props, fakeTerminal(40, 120)).render(120);
    expect(small.length).toBe(15);
    expect(big.length).toBe(40);
  });

  it('shows the header row with TASK BROWSER title and counts', () => {
    const props: Partial<TasksBrowserProps> = {
      tasks: [
        task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
        task({ taskId: 'agent-bbbbbbbb', status: 'completed' }),
      ],
    };
    const out = strip(makeApp(props).render(120).join('\n'));
    expect(out).toContain('TASK BROWSER');
    expect(out).toContain('filter=ALL');
    expect(out).toContain('1 running');
    expect(out).toContain('1 completed');
    expect(out).toContain('2 total');
  });

  it('renders three framed panes: Tasks / Detail / Preview Output', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
        selectedTaskId: 'bash-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Tasks [all]');
    expect(out).toContain('Detail');
    expect(out).toContain('Preview Output');
  });

  it('shows the selected task details in the Detail pane', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'bash-aaaaaaaa',
            status: 'running',
            description: 'long running task',
            pid: 9999,
          }),
        ],
        selectedTaskId: 'bash-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Task ID:');
    expect(out).toContain('bash-aaaaaaaa');
    expect(out).toContain('long running task');
  });

  it('shows question task details in the Detail pane', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'question-aaaaaaaa',
            kind: 'question',
            description: 'Which database?',
            questionCount: 1,
            toolCallId: 'call_question',
          }),
        ],
        selectedTaskId: 'question-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('question-aaaaaaaa');
    expect(out).toContain('Questions:');
    expect(out).toContain('1');
    expect(out).toContain('Tool call:');
    expect(out).toContain('call_question');
  });

  it('renders tail output in the Preview Output pane', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailOutput: 'ready in 432ms\nlistening on :3000',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('ready in 432ms');
    expect(out).toContain('listening on :3000');
  });

  it('shows a loading state when tail is loading', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailLoading: true,
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('[loading');
  });

  it('shows empty-state copy in the Tasks pane when no tasks', () => {
    const out = strip(makeApp().render(120).join('\n'));
    expect(out).toContain('No background tasks');
  });

  it('filters out terminal tasks when filter=active', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'completed' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'active' }).render(120).join('\n'));
    expect(out).toContain('bash-aaaaaaaa');
    expect(out).not.toContain('bash-bbbbbbbb');
  });

  it('filters out foreground tasks (detached === false)', () => {
    const tasks = [
      task({ taskId: 'bash-foreground', detached: false, status: 'running' }),
      task({ taskId: 'bash-background', detached: true, status: 'running' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).not.toContain('bash-foreground');
    expect(out).toContain('bash-background');
  });

  it('keeps background tasks with detached === true even when terminal', () => {
    const tasks = [task({ taskId: 'bash-done', detached: true, status: 'completed' })];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).toContain('bash-done');
  });

  it('keeps ghost tasks whose detached field is undefined', () => {
    // task() leaves `detached` undefined by default, mimicking reconcile ghosts.
    const tasks = [task({ taskId: 'bash-ghost', status: 'lost' })];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).toContain('bash-ghost');
  });

  it('applies active filter after excluding foreground tasks', () => {
    const tasks = [
      task({ taskId: 'bash-fg-running', detached: false, status: 'running' }),
      task({ taskId: 'bash-bg-running', detached: true, status: 'running' }),
      task({ taskId: 'bash-bg-done', detached: true, status: 'completed' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'active' }).render(120).join('\n'));
    expect(out).not.toContain('bash-fg-running');
    expect(out).toContain('bash-bg-running');
    expect(out).not.toContain('bash-bg-done');
  });

  it('renders without throwing for every AgentTaskStatus', () => {
    const statuses: AgentTaskStatus[] = [
      'running',
      'completed',
      'failed',
      'killed',
      'lost',
    ];
    for (const status of statuses) {
      const props = makeProps({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status })],
        selectedTaskId: 'bash-aaaaaaaa',
      });
      expect(() => new TasksBrowserApp(props, fakeTerminal(30)).render(120)).not.toThrow();
    }
  });

  it('falls back to a single line when the terminal is too small', () => {
    const out = strip(makeApp({}, 5, 30).render(30).join('\n'));
    expect(out).toContain('too small');
  });
});

describe('TasksBrowserApp — input handling', () => {
  it('Esc invokes onCancel', () => {
    const onCancel = vi.fn();
    const app = makeApp({ onCancel });
    app.handleInput('');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('q invokes onCancel', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput('q');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Tab invokes onToggleFilter', () => {
    const onToggleFilter = vi.fn();
    makeApp({ onToggleFilter }).handleInput('\t');
    expect(onToggleFilter).toHaveBeenCalledTimes(1);
  });

  it('R invokes onRefresh', () => {
    const onRefresh = vi.fn();
    makeApp({ onRefresh }).handleInput('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move selection and invoke onSelect', () => {
    const onSelect = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
      task({ taskId: 'bash-cccccccc', status: 'running', startedAt: 3 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    app.handleInput('[B'); // ↓
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('bash-cccccccc');
    app.handleInput('[A'); // ↑
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
  });

  it('Enter and O both invoke onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onOpenOutput,
    });
    app.handleInput('o');
    app.handleInput('\r');
    expect(onOpenOutput).toHaveBeenCalledTimes(2);
    expect(onOpenOutput).toHaveBeenCalledWith('bash-aaaaaaaa');
  });
});

// When a terminal (e.g. the VSCode integrated terminal) enables the Kitty
// keyboard protocol disambiguate flag, ordinary printable keys arrive as
// CSI-u sequences: `r` → "\x1b[114u", `q` → "\x1b[113u". These tests pin
// down that the tasks panel's literal-character shortcuts still fire
// under Kitty mode.
describe('TasksBrowserApp — Kitty CSI-u printable input', () => {
  const kitty = (ch: string): string => `\u001B[${String(ch.codePointAt(0) ?? 0)}u`;

  it('Kitty-encoded q invokes onCancel', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput(kitty('q'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded r invokes onRefresh', () => {
    const onRefresh = vi.fn();
    makeApp({ onRefresh }).handleInput(kitty('r'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded j moves selection down', () => {
    const onSelect = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    app.handleInput(kitty('j'));
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
  });

  it('Kitty-encoded o invokes onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onOpenOutput,
    });
    app.handleInput(kitty('o'));
    expect(onOpenOutput).toHaveBeenCalledWith('bash-aaaaaaaa');
  });

  it('Kitty-encoded s → y confirms a stop', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput(kitty('s'));
    app.handleInput(kitty('y'));
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-aaaaaaaa');
  });
});

describe('TasksBrowserApp — stop confirmation', () => {
  it('S → y confirms a stop and invokes onStopConfirmed', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput('s');
    const after = strip(app.render(120).join('\n'));
    expect(after).toContain('Stop bash-aaaaaaaa?');
    app.handleInput('y');
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-aaaaaaaa');
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('S → n cancels without firing onStopConfirmed', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput('s');
    app.handleInput('n');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('S → Esc cancels the confirm without closing the panel', () => {
    const onStopConfirmed = vi.fn();
    const onCancel = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
      onCancel,
    });
    app.handleInput('s');
    app.handleInput('');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('S on a terminal task invokes onStopIgnored and stays out of confirm mode', () => {
    const onStopConfirmed = vi.fn();
    const onStopIgnored = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'completed', exitCode: 0 })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
      onStopIgnored,
    });
    app.handleInput('s');
    expect(onStopIgnored).toHaveBeenCalledWith('bash-aaaaaaaa', 'terminal');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('navigation during confirm mode is locked out', () => {
    const onSelect = vi.fn();
    const onStopConfirmed = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect, onStopConfirmed });
    app.handleInput('s');
    onSelect.mockClear();
    app.handleInput('[B'); // ↓ arrow should be swallowed
    expect(onSelect).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });
});

describe('TasksBrowserApp — setProps', () => {
  it('keeps selection across prop updates when the task still exists', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running' }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-bbbbbbbb' });
    app.setProps({
      ...makeProps({
        tasks: [...tasks, task({ taskId: 'bash-cccccccc', status: 'completed' })],
        selectedTaskId: 'bash-bbbbbbbb',
      }),
    });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('bash-bbbbbbbb');
  });

  it('switches the filter via setProps without throwing', () => {
    const tasks = [task({ status: 'completed' })];
    const filters: TasksFilter[] = ['all', 'active', 'all'];
    const app = makeApp({ tasks });
    for (const filter of filters) {
      expect(() => {
        app.setProps(makeProps({ tasks, filter }));
      }).not.toThrow();
    }
  });
});
