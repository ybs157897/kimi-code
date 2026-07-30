/**
 * Scenario: editor keyboard shortcuts route cancellation, undo, and history
 * behavior through the public TUI host boundary.
 * Responsibilities: active-session cancellation uses neutral runtime ports,
 * while shortcut priority and history behavior remain stable.
 * Wiring: the editor and TUI host ports are small in-memory fakes.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/controllers/editor-keyboard.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOUBLE_ESC_WINDOW_MS } from '#/tui/constant/kimi-tui';
import {
  EditorKeyboardController,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

interface Harness {
  readonly host: EditorKeyboardHost;
  readonly editor: Record<string, ((...args: never[]) => unknown) | undefined>;
  readonly openUndoSelector: ReturnType<typeof vi.fn>;
  readonly cancelRunningShellCommand: ReturnType<typeof vi.fn>;
  readonly agentCancel: ReturnType<typeof vi.fn>;
  readonly cancelCompaction: ReturnType<typeof vi.fn>;
  readonly requireSessionRuntime: ReturnType<typeof vi.fn>;
  readonly steerMessage: ReturnType<typeof vi.fn>;
  readonly showError: ReturnType<typeof vi.fn>;
  readonly track: ReturnType<typeof vi.fn>;
  readonly handlePlanToggle: ReturnType<typeof vi.fn>;
  readonly btwCancelRunning: ReturnType<typeof vi.fn>;
  readonly btwCloseOrCancel: ReturnType<typeof vi.fn>;
}

function createHarness(
  options: {
    streamingPhase?: string;
    isCompacting?: boolean;
    sessionId?: string;
  } = {},
): Harness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
    getText: vi.fn(() => '') as unknown as (...args: never[]) => unknown,
    setText: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const openUndoSelector = vi.fn();
  const cancelRunningShellCommand = vi.fn();
  const agentCancel = vi.fn(async () => {});
  const cancelCompaction = vi.fn(async () => {});
  const requireSessionRuntime = vi.fn(() => ({
    agent: { cancel: agentCancel },
    context: { cancelCompaction },
  }));
  const steerMessage = vi.fn();
  const showError = vi.fn();
  const track = vi.fn();
  const handlePlanToggle = vi.fn();
  const btwCancelRunning = vi.fn(() => false);
  const btwCloseOrCancel = vi.fn(() => false);

  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: {
        model: 'k2',
        sessionId: options.sessionId ?? 'session-1',
        planMode: false,
        streamingPhase: options.streamingPhase ?? 'idle',
        isCompacting: options.isCompacting ?? false,
      },
      queuedMessages: [],
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    btwPanelController: { cancelRunning: btwCancelRunning, closeOrCancel: btwCloseOrCancel },
    requireSessionRuntime,
    steerMessage,
    validateMediaCapabilities: vi.fn(() => true),
    updateQueueDisplay: vi.fn(),
    showError,
    track,
    handlePlanToggle,
    openUndoSelector,
    cancelRunningShellCommand,
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(
    host,
    undefined as unknown as ImageAttachmentStore,
  );
  controller.install();

  return {
    host,
    editor,
    openUndoSelector,
    cancelRunningShellCommand,
    agentCancel,
    cancelCompaction,
    requireSessionRuntime,
    steerMessage,
    showError,
    track,
    handlePlanToggle,
    btwCancelRunning,
    btwCloseOrCancel,
  };
}

function pressEscape(editor: Harness['editor']): void {
  const handler = editor['onEscape'];
  if (handler === undefined) throw new Error('onEscape handler not installed');
  (handler as () => void)();
}

function pressCtrlC(editor: Harness['editor']): void {
  const handler = editor['onCtrlC'];
  if (handler === undefined) throw new Error('onCtrlC handler not installed');
  (handler as () => void)();
}

function pressCtrlS(editor: Harness['editor']): void {
  const handler = editor['onCtrlS'];
  if (handler === undefined) throw new Error('onCtrlS handler not installed');
  (handler as () => void)();
}

function pressShiftTab(editor: Harness['editor']): void {
  const handler = editor['onShiftTab'];
  if (handler === undefined) throw new Error('onShiftTab handler not installed');
  (handler as () => void)();
}

function pressNonEscape(editor: Harness['editor']): void {
  const handler = editor['onNonEscapeInput'];
  if (handler === undefined) throw new Error('onNonEscapeInput handler not installed');
  (handler as () => void)();
}

describe('EditorKeyboardController double-Esc undo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the undo selector when Esc is pressed twice within the window while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledOnce();
  });

  it('does nothing for a single Esc while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when the second Esc arrives after the window expires', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    vi.advanceTimersByTime(DOUBLE_ESC_WINDOW_MS + 1);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when another key is pressed between the two Esc presses', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    pressNonEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger undo while streaming; Esc cancels the stream instead', () => {
    const { editor, openUndoSelector, cancelRunningShellCommand, agentCancel } = createHarness({
      streamingPhase: 'waiting',
    });

    pressEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
    expect(cancelRunningShellCommand).toHaveBeenCalled();
    expect(agentCancel).toHaveBeenCalled();
  });
});

describe('EditorKeyboardController steer dispatch', () => {
  it('steers queued input through the active binding when the raw session is absent', () => {
    const { host, editor, steerMessage } = createHarness({ streamingPhase: 'waiting' });
    host.state.queuedMessages = [{ text: 'focus on the tests', agentId: 'main' }];

    pressCtrlS(editor);

    expect(steerMessage).toHaveBeenCalledWith([{ text: 'focus on the tests' }]);
    expect(host.state.queuedMessages).toEqual([]);
  });
});

describe('EditorKeyboardController plan toggle', () => {
  it('shows the no-session error when the active runtime is unavailable', () => {
    const {
      editor,
      requireSessionRuntime,
      showError,
      track,
      handlePlanToggle,
    } = createHarness();
    requireSessionRuntime.mockImplementationOnce(() => {
      throw new Error('no active runtime');
    });

    pressShiftTab(editor);

    expect(showError).toHaveBeenCalledWith('No active session. Send /login to login.');
    expect(track).not.toHaveBeenCalled();
    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('toggles plan mode through the active session runtime', () => {
    const {
      editor,
      requireSessionRuntime,
      showError,
      track,
      handlePlanToggle,
    } = createHarness();

    pressShiftTab(editor);

    expect(requireSessionRuntime).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();
    expect(track).toHaveBeenNthCalledWith(1, 'shortcut_plan_toggle', { enabled: true });
    expect(track).toHaveBeenNthCalledWith(2, 'shortcut_mode_switch', { to_mode: 'plan' });
    expect(handlePlanToggle).toHaveBeenCalledWith(true);
  });
});

describe('EditorKeyboardController btw panel priority', () => {
  it('Esc closes the btw panel first while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Esc cancels compaction on the next press once the btw panel is gone', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValueOnce(true);

    pressEscape(editor);
    expect(cancelCompaction).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('Esc cancels compaction directly when no btw panel is open', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('Ctrl+C cancels a running btw question first while compacting', () => {
    const { editor, btwCancelRunning, cancelCompaction } = createHarness({ isCompacting: true });
    btwCancelRunning.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C closes an idle btw panel while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C cancels compaction when no btw panel is open', () => {
    const { editor, btwCancelRunning, btwCloseOrCancel, cancelCompaction } = createHarness({
      isCompacting: true,
    });

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledOnce();
    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('does not cancel compaction when no session id is active', () => {
    const { editor, requireSessionRuntime, cancelCompaction } = createHarness({
      isCompacting: true,
      sessionId: '',
    });

    pressEscape(editor);

    expect(requireSessionRuntime).not.toHaveBeenCalled();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('shows the existing error when context cancellation fails', async () => {
    const { editor, cancelCompaction, showError } = createHarness({
      isCompacting: true,
    });
    cancelCompaction.mockRejectedValueOnce(new Error('cancel failed'));

    pressEscape(editor);
    await Promise.resolve();

    expect(showError).toHaveBeenCalledWith(
      'Failed to cancel compaction: cancel failed',
    );
  });
});

describe('EditorKeyboardController stream cancellation', () => {
  it('still cancels the shell while skipping the agent without a session id', () => {
    const {
      editor,
      cancelRunningShellCommand,
      requireSessionRuntime,
      agentCancel,
    } = createHarness({
      streamingPhase: 'waiting',
      sessionId: '',
    });

    pressEscape(editor);

    expect(cancelRunningShellCommand).toHaveBeenCalledOnce();
    expect(requireSessionRuntime).not.toHaveBeenCalled();
    expect(agentCancel).not.toHaveBeenCalled();
  });
});

describe('EditorKeyboardController shell history recall', () => {
  type Recall = (entry: string, direction: 1 | -1) => string | undefined;
  type Mock = ReturnType<typeof vi.fn>;

  it('installs a filter that allows shell entries only in bash mode', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    expect(setHistoryFilter).toHaveBeenCalledOnce();
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(true);

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(false);
  });

  it('locks the filter to the browse-entry mode once browsing starts', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    // Enter browse from prompt mode, then simulate landing on a shell entry
    // (which flips inputMode to bash). The filter should stay locked to prompt
    // and keep allowing plain entries.
    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    save();
    (editor as unknown as { inputMode: string }).inputMode = 'bash';

    expect(filter('hello')).toBe(true);
    expect(filter('!cmd')).toBe(true);
  });

  it('strips the leading ! and switches to bash mode when recalling a shell entry', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('!cmd', -1);

    expect(result).toBe('cmd');
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('bash');
  });

  it('keeps plain entries as-is and switches to prompt mode', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('hello', -1);

    expect(result).toBeUndefined();
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });

  it('saves the current input mode as the history draft host state', () => {
    const { editor } = createHarness();
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(save()).toBe('prompt');

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(save()).toBe('bash');
  });

  it('restores the input mode from the saved draft host state', () => {
    const { editor } = createHarness();
    const restore = editor['onHistoryDraftRestore'] as unknown as (state: unknown) => void;

    restore('prompt');

    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });
});
