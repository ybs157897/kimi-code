/**
 * Exercises the public `/goal` command contract: parsing, runtime-agent goal
 * control, and runtime-bound upcoming-goal queue delegation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchInput,
  goalArgumentCompletions,
  handleGoalCommand,
  parseGoalCommand,
  setExperimentalFeatures,
} from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { getBuiltInPalette } from '#/tui/theme';

const ENTER = '\r';
const ESCAPE = '\u001B';
const UP = '\u001B[A';
const DOWN = '\u001B[B';

function fakeSnapshot() {
  return {
    goalId: 'g1',
    objective: 'obj',
    status: 'active' as const,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: 20,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: 20,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function errorWithCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function makeHost(
  overrides: {
    model?: string;
    hasSession?: boolean;
    hasRuntime?: boolean;
    streaming?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
  } = {},
) {
  const agent = {
    setPermission: vi.fn(async () => {}),
    createGoal: vi.fn(async () => fakeSnapshot()),
    getGoal: vi.fn(async (): Promise<ReturnType<typeof fakeSnapshot> | null> => null),
    pauseGoal: vi.fn(async () => fakeSnapshot()),
    resumeGoal: vi.fn(async () => fakeSnapshot()),
    cancelGoal: vi.fn(async () => fakeSnapshot()),
    cancel: vi.fn(async () => {}),
  };
  const session = {};
  const hasSession = overrides.hasSession ?? true;
  const hasRuntime = overrides.hasRuntime ?? true;
  const goalQueue = {
    append: vi.fn(async () => ({
      goals: [{ id: 'q1', objective: 'obj', createdAt: '', updatedAt: '' }],
    })),
    read: vi.fn(async () => ({
      goals: [
        { id: 'q1', objective: 'First queued goal', createdAt: '', updatedAt: '' },
        { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
      ],
    })),
    move: vi.fn(async () => ({
      goals: [
        { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
        { id: 'q1', objective: 'First queued goal', createdAt: '', updatedAt: '' },
      ],
    })),
    remove: vi.fn(async () => ({
      goals: [{ id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' }],
    })),
    restore: vi.fn(async () => ({
      goals: [
        { id: 'q1', objective: 'First queued goal', createdAt: '', updatedAt: '' },
        { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
      ],
    })),
    update: vi.fn(async () => ({
      goals: [
        { id: 'q1', objective: 'First queued goal updated', createdAt: '', updatedAt: '' },
        { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
      ],
    })),
  };
  const runtime = { agent, goalQueue };
  const transcriptContainer = { addChild: vi.fn() };
  const requireSession = vi.fn(() => {
    if (!hasSession) throw new Error('No active raw session');
    return session;
  });
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'kimi-model',
        permissionMode: overrides.permissionMode ?? 'auto',
        streamingPhase: overrides.streaming ? 'streaming' : 'idle',
        isCompacting: false,
      },
      transcriptContainer,
      ui: { requestRender: vi.fn() },
      theme: { palette: getBuiltInPalette('dark') },
    },
    session: hasSession ? session : undefined,
    skillCommandMap: new Map<string, string>(),
    requireSession,
    requireSessionRuntime: () => {
      if (!hasRuntime) throw new Error('No active session runtime');
      return runtime;
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
    requestQueuedGoalPromotion: vi.fn(),
    cancelInFlight: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session, agent, goalQueue, requireSession };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

function latestMountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls.at(-1)?.[0] as TestPicker;
}

describe('parseGoalCommand', () => {
  it('treats empty and status as status', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('status')).toEqual({ kind: 'status' });
  });

  it('parses control subcommands', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('cancel')).toEqual({ kind: 'cancel' });
  });

  it('treats `clear` as an objective, not a subcommand (cancel is the remove action)', () => {
    expect(parseGoalCommand('clear')).toMatchObject({ kind: 'create', objective: 'clear' });
  });

  it('parses a plain objective', () => {
    expect(parseGoalCommand('Ship feature X')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature X',
      replace: false,
    });
  });

  it('keeps option-looking tokens as part of the objective (no goal flags)', () => {
    // Goal command flags are not parsed after `/goal`; stop conditions go in the
    // objective as natural language, so option-looking text stays objective text.
    expect(parseGoalCommand('--retry-strategy Ship feature X')).toMatchObject({
      kind: 'create',
      objective: '--retry-strategy Ship feature X',
    });
  });

  it('treats text after -- as the objective', () => {
    expect(parseGoalCommand('-- --leading-option is part of the goal')).toMatchObject({
      kind: 'create',
      objective: '--leading-option is part of the goal',
    });
    expect(parseGoalCommand('-- cancel')).toMatchObject({ kind: 'create', objective: 'cancel' });
  });

  it('parses replace as the first argument', () => {
    expect(parseGoalCommand('replace Ship feature Y')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature Y',
      replace: true,
    });
  });

  it('parses next as an upcoming-goal command', () => {
    expect(parseGoalCommand('next Ship release notes')).toEqual({
      kind: 'next-add',
      objective: 'Ship release notes',
    });
    expect(parseGoalCommand('next manage')).toEqual({ kind: 'next-manage' });
    expect(parseGoalCommand('next -- manage release notes')).toEqual({
      kind: 'next-add',
      objective: 'manage release notes',
    });
  });

  it('shows a hint for /goal next without an objective', () => {
    expect(parseGoalCommand('next')).toEqual({
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    });
  });

  it('rejects objectives longer than 4000 characters', () => {
    expect(parseGoalCommand('x'.repeat(4001))).toMatchObject({ kind: 'error' });
  });
});

describe('handleGoalCommand', () => {
  let host: SlashCommandHost;
  let agent: ReturnType<typeof makeHost>['agent'];
  let goalQueue: ReturnType<typeof makeHost>['goalQueue'];

  beforeEach(() => {
    const made = makeHost();
    host = made.host;
    agent = made.agent;
    goalQueue = made.goalQueue;
  });

  it('/goal calls getGoal and does not send input', async () => {
    await handleGoalCommand(host, '');
    expect(agent.getGoal).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith('goal_status', { status: 'none' });
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal status uses the runtime agent when the raw session is unavailable', async () => {
    const { host: runtimeHost, agent: runtimeAgent } = makeHost({ hasSession: false });

    await handleGoalCommand(runtimeHost, 'status');

    expect(runtimeAgent.getGoal).toHaveBeenCalledOnce();
    expect(runtimeHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal <objective> uses the runtime agent when the raw session is unavailable', async () => {
    const { host: runtimeHost, agent: runtimeAgent } = makeHost({ hasSession: false });

    await handleGoalCommand(runtimeHost, 'Ship feature X');

    expect(runtimeAgent.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature X', replace: false }),
    );
    expect(runtimeHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    expect(runtimeHost.sendNormalUserInput).not.toHaveBeenCalledWith('/goal Ship feature X');
  });

  it('/goal <objective> keeps the sendNormalUserInput host receiver', async () => {
    const calls: Array<{ receiver: unknown; text: string }> = [];
    host.sendNormalUserInput = function (this: unknown, text: string): void {
      calls.push({ receiver: this, text });
    };

    await handleGoalCommand(host, 'Ship feature X');

    expect(calls).toEqual([{ receiver: host, text: 'Ship feature X' }]);
  });

  it('asks before starting a goal in Manual mode', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');

    expect(manualHost.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(a.createGoal).not.toHaveBeenCalled();
    expect(manualHost.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(manualHost).render(80).join('\n'));
    expect(text).toContain('Manual mode is not suitable for unattended goal work');
    expect(text).toContain('Return to the input box with your goal command');
  });

  it('defaults to Auto when confirming a Manual-mode goal start', async () => {
    const { host: manualHost, agent: a } = makeHost({
      hasSession: false,
      permissionMode: 'manual',
    });

    await handleGoalCommand(manualHost, 'Ship feature X');
    mountedPicker(manualHost).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(a.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(a.setPermission).toHaveBeenCalledWith('auto');
    expect(manualHost.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(manualHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('can start a Manual-mode goal without changing permission', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    const picker = mountedPicker(manualHost);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(a.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(a.setPermission).not.toHaveBeenCalled();
    expect(manualHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('can switch to YOLO when starting a Manual-mode goal', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    const picker = mountedPicker(manualHost);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(a.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(a.setPermission).toHaveBeenCalledWith('yolo');
    expect(manualHost.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('restores the previous permission mode when the goal fails to start', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });
    a.createGoal = vi.fn(async () => {
      throw errorWithCode('goal.already_exists', 'A goal already exists');
    });

    await handleGoalCommand(manualHost, 'Ship feature X');
    const picker = mountedPicker(manualHost);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      // Switched to YOLO to run the goal, then restored to Manual on failure.
      expect(a.setPermission).toHaveBeenLastCalledWith('manual');
    });
    expect(a.setPermission).toHaveBeenCalledWith('yolo');
    expect(manualHost.setAppState).toHaveBeenLastCalledWith({ permissionMode: 'manual' });
  });

  it('returns the command to the input box when a Manual-mode goal start is cancelled', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    mountedPicker(manualHost).handleInput(ESCAPE);

    expect(manualHost.restoreInputText).toHaveBeenCalledWith('/goal Ship feature X');
    expect(manualHost.showStatus).toHaveBeenCalledWith('Goal not started.');
    expect(a.createGoal).not.toHaveBeenCalled();
  });

  it('returns the command to the input box when Do not start is selected', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'replace Ship feature Y');
    const picker = mountedPicker(manualHost);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    expect(manualHost.restoreInputText).toHaveBeenCalledWith('/goal replace Ship feature Y');
    expect(a.createGoal).not.toHaveBeenCalled();
  });

  it('asks before starting a goal in YOLO mode', async () => {
    const { host: yoloHost, agent: a } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'Ship feature X');

    expect(yoloHost.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(a.createGoal).not.toHaveBeenCalled();
    expect(yoloHost.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(yoloHost).render(80).join('\n'));
    expect(text).toContain('YOLO mode can still stop for questions');
    expect(text).toContain('Keep YOLO and start');
    expect(text).not.toContain('Start in Manual');
  });

  it('defaults to Auto when confirming a YOLO-mode goal start', async () => {
    const { host: yoloHost, agent: a } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'Ship feature X');
    mountedPicker(yoloHost).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(a.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(a.setPermission).toHaveBeenCalledWith('auto');
    expect(yoloHost.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(yoloHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('can keep YOLO when starting a YOLO-mode goal', async () => {
    const { host: yoloHost, agent: a } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'Ship feature X');
    const picker = mountedPicker(yoloHost);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(a.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(a.setPermission).not.toHaveBeenCalled();
    expect(yoloHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('returns the command to the input box when a YOLO-mode goal start is cancelled', async () => {
    const { host: yoloHost, agent: a } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'replace Ship feature Y');
    const picker = mountedPicker(yoloHost);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    expect(yoloHost.restoreInputText).toHaveBeenCalledWith('/goal replace Ship feature Y');
    expect(a.createGoal).not.toHaveBeenCalled();
  });

  it('does not pass budget limits (flags were removed)', async () => {
    await handleGoalCommand(host, 'Ship feature X');
    const arg = (agent.createGoal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg).not.toHaveProperty('budgetLimits');
  });

  it('rejects too-long objectives before calling the runtime', async () => {
    await handleGoalCommand(host, 'x'.repeat(4001));
    expect(host.showError).toHaveBeenCalled();
    expect(agent.createGoal).not.toHaveBeenCalled();
  });

  it('/goal replace passes replace: true', async () => {
    await handleGoalCommand(host, 'replace Ship feature Y');
    expect(agent.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature Y', replace: true }),
    );
  });

  it('/goal next queues through a runtime-only host without sending agent input', async () => {
    const {
      host: runtimeOnlyHost,
      agent: runtimeAgent,
      goalQueue: runtimeGoalQueue,
      requireSession,
    } = makeHost({ hasSession: false });
    runtimeAgent.getGoal.mockResolvedValueOnce(fakeSnapshot());

    await handleGoalCommand(runtimeOnlyHost, 'next Ship release notes');

    expect(runtimeAgent.getGoal).toHaveBeenCalledOnce();
    expect(runtimeGoalQueue.append).toHaveBeenCalledWith({
      objective: 'Ship release notes',
    });
    expect(requireSession).not.toHaveBeenCalled();
    expect(runtimeOnlyHost.track).toHaveBeenCalledWith('goal_queue_append');
    expect(runtimeOnlyHost.showStatus).not.toHaveBeenCalledWith(
      'Upcoming goal added. It will start after the current goal is complete.',
    );
    const addChild = runtimeOnlyHost.state.transcriptContainer
      .addChild as ReturnType<typeof vi.fn>;
    const message = addChild.mock.calls[0]?.[0] as { render(width: number): string[] };
    expect(stripAnsi(message.render(80).join('\n'))).toBe(
      '\n● Upcoming goal added. It will start after the current goal is complete.',
    );
    expect(runtimeOnlyHost.state.ui.requestRender).toHaveBeenCalled();
    expect(runtimeOnlyHost.sendNormalUserInput).not.toHaveBeenCalled();
    expect(runtimeAgent.createGoal).not.toHaveBeenCalled();
  });

  it('/goal next starts immediately when there is no current goal', async () => {
    await handleGoalCommand(host, 'next Ship release notes');

    expect(agent.getGoal).toHaveBeenCalledOnce();
    expect(goalQueue.append).not.toHaveBeenCalled();
    expect(agent.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship release notes', replace: false }),
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      'No active goal. Starting this goal now.',
    );
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship release notes');
  });

  it('/goal next queues instead of starting immediately while streaming with no current goal', async () => {
    const {
      host: streamingHost,
      goalQueue: streamingGoalQueue,
      agent: a,
    } = makeHost({ streaming: true });

    await handleGoalCommand(streamingHost, 'next Ship release notes');

    expect(a.getGoal).toHaveBeenCalledOnce();
    expect(streamingGoalQueue.append).toHaveBeenCalledWith({
      objective: 'Ship release notes',
    });
    expect(streamingHost.requestQueuedGoalPromotion).toHaveBeenCalledOnce();
    expect(a.createGoal).not.toHaveBeenCalled();
    expect(streamingHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal next follows the normal goal-start prompt when there is no current goal', async () => {
    const { host: manualHost, agent: a } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'next Ship release notes');

    expect(a.getGoal).toHaveBeenCalledOnce();
    expect(goalQueue.append).not.toHaveBeenCalled();
    expect(manualHost.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(a.createGoal).not.toHaveBeenCalled();

    mountedPicker(manualHost).handleInput(ESCAPE);
    expect(manualHost.restoreInputText).toHaveBeenCalledWith('/goal next Ship release notes');
  });

  it('/goal next does not require a configured model when queueing after a current goal', async () => {
    const {
      host: noModelHost,
      goalQueue: noModelGoalQueue,
      agent: a,
    } = makeHost({ model: '' });
    a.getGoal.mockResolvedValueOnce(fakeSnapshot());

    await handleGoalCommand(noModelHost, 'next Ship release notes');

    expect(noModelGoalQueue.append).toHaveBeenCalledWith({
      objective: 'Ship release notes',
    });
    expect(noModelHost.showError).not.toHaveBeenCalled();
  });

  it('/goal next requires a configured model when it starts immediately', async () => {
    const { host: noModelHost, agent: a } = makeHost({ model: '' });

    await handleGoalCommand(noModelHost, 'next Ship release notes');

    expect(a.getGoal).toHaveBeenCalledOnce();
    expect(goalQueue.append).not.toHaveBeenCalled();
    expect(a.createGoal).not.toHaveBeenCalled();
    expect(noModelHost.showError).toHaveBeenCalled();
  });

  it('/goal next manage opens the upcoming goal manager without sending input', async () => {
    await handleGoalCommand(host, 'next manage');

    expect(goalQueue.read).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith('goal_queue_manage');
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const text = stripAnsi(mountedPicker(host).render(100).join('\n'));
    expect(text).toContain('Upcoming goals');
    expect(text).toContain('First queued goal');
    expect(text).toContain('Second queued goal');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(agent.createGoal).not.toHaveBeenCalled();
  });

  it('/goal next manage reorders goals through the runtime queue', async () => {
    await handleGoalCommand(host, 'next manage');
    const manager = mountedPicker(host);

    manager.handleInput(DOWN);
    manager.handleInput(' ');
    manager.handleInput(UP);

    await vi.waitFor(() => {
      expect(goalQueue.move).toHaveBeenCalledWith({
        goalId: 'q2',
        direction: 'up',
      });
    });
  });

  it('/goal next manage removes goals through the runtime queue', async () => {
    await handleGoalCommand(host, 'next manage');

    mountedPicker(host).handleInput('d');

    await vi.waitFor(() => {
      expect(goalQueue.remove).toHaveBeenCalledWith({ goalId: 'q1' });
    });
  });

  it('/goal next manage edits goals through the runtime queue', async () => {
    await handleGoalCommand(host, 'next manage');

    mountedPicker(host).handleInput('e');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    });
    const editDialog = latestMountedPicker(host);
    editDialog.handleInput(' updated');
    editDialog.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(goalQueue.update).toHaveBeenCalledWith({
        goalId: 'q1',
        objective: 'First queued goal updated',
      });
    });
  });

  it('surfaces duplicate-goal errors with replace guidance', async () => {
    agent.createGoal.mockRejectedValueOnce(
      errorWithCode('goal.already_exists', 'exists'),
    );
    await handleGoalCommand(host, 'Ship feature X');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('/goal replace'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal pause uses the runtime agent when the raw session is unavailable', async () => {
    const { host: runtimeHost, agent: runtimeAgent } = makeHost({ hasSession: false });

    await handleGoalCommand(runtimeHost, 'pause');

    expect(runtimeAgent.pauseGoal).toHaveBeenCalledOnce();
    expect(runtimeHost.track).toHaveBeenCalledWith('goal_pause');
    expect(runtimeHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal pause cancels an active stream', async () => {
    const { host: streamingHost, agent: a } = makeHost({
      hasSession: false,
      streaming: true,
    });
    await handleGoalCommand(streamingHost, 'pause');
    expect(a.pauseGoal).toHaveBeenCalledOnce();
    expect(a.cancel).toHaveBeenCalledOnce();
  });

  it('/goal resume uses the runtime agent when the raw session is unavailable', async () => {
    const { host: runtimeHost, agent: runtimeAgent } = makeHost({ hasSession: false });

    await handleGoalCommand(runtimeHost, 'resume');

    expect(runtimeAgent.resumeGoal).toHaveBeenCalledOnce();
    expect(runtimeHost.track).toHaveBeenCalledWith('goal_resume');
    expect(runtimeHost.showStatus).not.toHaveBeenCalledWith('Goal resumed.');
    expect(runtimeHost.sendNormalUserInput).toHaveBeenCalledWith('Resume the active goal.');
  });

  it('/goal cancel uses the runtime agent when the raw session is unavailable', async () => {
    const { host: runtimeHost, agent: runtimeAgent } = makeHost({ hasSession: false });

    await handleGoalCommand(runtimeHost, 'cancel');

    expect(runtimeAgent.cancelGoal).toHaveBeenCalledOnce();
    expect(runtimeHost.track).toHaveBeenCalledWith('goal_cancel');
    expect(runtimeHost.showNotice).toHaveBeenCalledWith('Goal cancelled.');
    expect(runtimeHost.showStatus).not.toHaveBeenCalledWith('Goal cancelled.');
    expect(runtimeHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal cancel cancels an active stream', async () => {
    const { host: streamingHost, agent: a } = makeHost({
      hasSession: false,
      streaming: true,
    });
    await handleGoalCommand(streamingHost, 'cancel');
    expect(a.cancelGoal).toHaveBeenCalledOnce();
    expect(a.cancel).toHaveBeenCalledOnce();
  });

  // No-goal control commands all read as calm status messages, never red errors.
  it('pausing with no goal shows a friendly status, not an error', async () => {
    agent.pauseGoal.mockRejectedValueOnce(
      errorWithCode('goal.not_found', 'No current goal'),
    );
    await handleGoalCommand(host, 'pause');
    expect(host.showStatus).toHaveBeenCalledWith('No goal to pause.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('resuming with no goal shows a friendly status, not an error', async () => {
    agent.resumeGoal.mockRejectedValueOnce(
      errorWithCode('goal.not_found', 'No current goal'),
    );
    await handleGoalCommand(host, 'resume');
    expect(host.showStatus).toHaveBeenCalledWith('No goal to resume.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('`replace` with no objective is a hint (status), not an error', async () => {
    await handleGoalCommand(host, 'replace');
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('Provide a goal objective'));
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('status/pause/cancel work without a configured model', async () => {
    const { host: noModelHost, agent: a } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'status');
    await handleGoalCommand(noModelHost, 'pause');
    await handleGoalCommand(noModelHost, 'cancel');
    expect(a.getGoal).toHaveBeenCalled();
    expect(a.pauseGoal).toHaveBeenCalled();
    expect(a.cancelGoal).toHaveBeenCalled();
    expect(noModelHost.showError).not.toHaveBeenCalled();
  });

  it('resume without a configured model does not activate the goal', async () => {
    const { host: noModelHost, agent: a } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'resume');
    expect(noModelHost.showError).toHaveBeenCalled();
    expect(a.resumeGoal).not.toHaveBeenCalled();
    expect(noModelHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('creation without a configured model shows LLM_NOT_SET_MESSAGE', async () => {
    const { host: noModelHost, agent: a } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'Ship feature X');
    expect(noModelHost.showError).toHaveBeenCalled();
    expect(a.createGoal).not.toHaveBeenCalled();
  });

  it('creation without an active runtime shows LLM_NOT_SET_MESSAGE', async () => {
    const { host: noRuntimeHost, agent: a } = makeHost({ hasRuntime: false });
    await handleGoalCommand(noRuntimeHost, 'Ship feature X');
    expect(noRuntimeHost.showError).toHaveBeenCalled();
    expect(a.createGoal).not.toHaveBeenCalled();
  });
});

describe('dispatchInput /goal integration', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('routes /goal through the real resolver, creates the goal, and sends the objective', async () => {
    const { host, agent } = makeHost();

    dispatchInput(host, '/goal Ship feature X');

    await vi.waitFor(() => {
      expect(agent.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    expect(host.sendNormalUserInput).not.toHaveBeenCalledWith('/goal Ship feature X');
  });
});

describe('goalArgumentCompletions', () => {
  function values(prefix: string): string[] | null {
    const items = goalArgumentCompletions(prefix);
    return items === null ? null : items.map((i) => i.value);
  }

  function labels(prefix: string): string[] | null {
    const items = goalArgumentCompletions(prefix);
    return items === null ? null : items.map((i) => i.label);
  }

  it('offers every subcommand for an empty prefix', () => {
    expect(values('')).toEqual(['status', 'pause', 'resume', 'cancel', 'replace', 'next']);
  });

  it('prefix-filters subcommands case-insensitively', () => {
    expect(values('pa')).toEqual(['pause']);
    expect(values('RE')).toEqual(['resume', 'replace']);
  });

  it('returns items whose value/label are the token itself', () => {
    const items = goalArgumentCompletions('paus');
    expect(items).toEqual([
      { value: 'pause', label: 'pause', description: 'Pause the active goal' },
    ]);
  });

  it('suppresses the menu once a token is fully typed and unambiguous', () => {
    // `status` is the sole match and equals the prefix exactly, so there is
    // nothing left to complete: the menu hides and Enter submits `/goal status`
    // instead of confirming a no-op completion.
    expect(values('status')).toBeNull();
    expect(values('pause')).toBeNull();
    // `re` still has two completions, so the menu stays open.
    expect(values('re')).toEqual(['resume', 'replace']);
  });

  it('stops completing once past the first token (space typed)', () => {
    expect(values('pause ')).toBeNull();
    expect(values('replace Ship feature')).toBeNull();
    expect(values('next Ship feature')).toBeNull();
  });

  it('completes /goal next manage as the second token', () => {
    expect(values('next ')).toEqual(['next manage']);
    expect(values('next m')).toEqual(['next manage']);
    expect(values('next MA')).toEqual(['next manage']);
    expect(labels('next m')).toEqual(['manage']);
    expect(values('next manage')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(values('zzz')).toBeNull();
    expect(values('next ship')).toBeNull();
  });
});
