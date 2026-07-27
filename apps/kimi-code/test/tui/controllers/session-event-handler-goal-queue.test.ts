import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

const queuedGoal = {
  id: 'q1',
  objective: 'Ship queued goal',
  createdAt: '',
  updatedAt: '',
} as const;

function fakeGoalSnapshot(objective: string, status: 'active' | 'blocked' | 'paused' | 'complete') {
  return {
    goalId: 'g1',
    objective,
    status,
    turnsUsed: 1,
    tokensUsed: 10,
    wallClockMs: 100,
    budget: {
      tokenBudget: null,
      turnBudget: 20,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: 19,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

function makeHost(options: { createGoalRejects?: boolean } = {}) {
  let eventListener: ((event: unknown) => void) | undefined;
  const events = {
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      eventListener = listener;
      return vi.fn();
    }),
  };
  const agent = {
    prompt: vi.fn(async (_input: string) => undefined),
    createGoal: vi.fn(async () => {
      if (options.createGoalRejects === true) throw new Error('create failed');
      return fakeGoalSnapshot('Ship queued goal', 'active');
    }),
    cancelGoal: vi.fn(async () => fakeGoalSnapshot('Ship queued goal', 'active')),
  };
  const goalQueue = {
    read: vi.fn(async () => ({ goals: [queuedGoal] })),
    remove: vi.fn(async () => ({ goals: [] })),
    restore: vi.fn(async () => ({ goals: [queuedGoal] })),
  };
  const runtime = {
    sessionId: 's1',
    agentId: 'main',
    agent,
    events,
    goalQueue,
    mcp: { list: vi.fn(async () => []) },
  };
  let activeRuntime = runtime;
  const requireSession = vi.fn(() => {
    throw new Error('raw Session is unavailable');
  });
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      beginCompaction: vi.fn(),
      endCompaction: vi.fn(),
      cancelCompaction: vi.fn(),
    },
    requireSession,
    requireSessionRuntime: vi.fn(() => activeRuntime),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });
  host.streamingUI.finalizeTurn.mockImplementation(() => {
    host.setAppState({ streamingPhase: 'idle' });
  });
  host.sendQueuedMessage.mockImplementation((item: { text: string }) => {
    void activeRuntime.agent.prompt(item.text);
  });
  return {
    host: host as any,
    agent,
    goalQueue,
    requireSession,
    runtime,
    emitEvent(event: unknown) {
      eventListener?.(event);
    },
    setActiveRuntime(nextRuntime: typeof runtime) {
      activeRuntime = nextRuntime;
    },
  };
}

function sendQueuedViaHost(host: ReturnType<typeof makeHost>['host']) {
  return (item: unknown) => {
    host.sendQueuedMessage(item as never);
  };
}

function completionEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: fakeGoalSnapshot('Current goal', 'complete'),
    change: {
      kind: 'completion',
      status: 'complete',
      stats: { turnsUsed: 1, tokensUsed: 10, wallClockMs: 100 },
    },
  } as const;
}

function clearedEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: null,
  } as const;
}

function turnEndedEvent() {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    reason: 'completed',
  } as const;
}

function compactionCompletedEvent() {
  return {
    type: 'compaction.completed',
    sessionId: 's1',
    agentId: 'main',
    result: {
      summary: 'summary',
      tokensBefore: 100,
      tokensAfter: 10,
      compactedCount: 1,
    },
  } as const;
}

function modelBlockedEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: fakeGoalSnapshot('Blocked goal', 'blocked'),
    change: { kind: 'lifecycle', status: 'blocked' },
  } as const;
}

function addedTranscriptText(host: ReturnType<typeof makeHost>['host']): string {
  const component = host.state.transcriptContainer.addChild.mock.calls.at(-1)?.[0];
  return component.render(80).join('\n').replaceAll(/\[[0-9;]*m/g, '');
}

describe('SessionEventHandler goal queue promotion', () => {
  it('starts the next queued goal after the completion turn ends', async () => {
    const { host, agent, goalQueue, requireSession } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    expect(agent.createGoal).not.toHaveBeenCalled();
    handler.handleEvent(clearedEvent(), vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.createGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host));

    await vi.waitFor(() => {
      expect(agent.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    expect(goalQueue.read).toHaveBeenCalledOnce();
    expect(goalQueue.remove).toHaveBeenCalledWith({ goalId: 'q1' });
    expect(host.sendQueuedMessage).toHaveBeenCalledWith({ text: 'Ship queued goal' });
    expect(agent.prompt).toHaveBeenCalledWith('Ship queued goal');
    expect(requireSession).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('waits for queued user input to drain before promoting the next queued goal', async () => {
    const { host, agent } = makeHost();
    host.state.queuedMessages = [{ text: 'queued user turn' }];
    host.shiftQueuedMessage.mockImplementation(() => host.state.queuedMessages.shift());
    host.streamingUI.finalizeTurn.mockImplementation((sendQueued: (item: unknown) => void) => {
      const next = host.shiftQueuedMessage();
      if (next !== undefined) {
        host.setAppState({ streamingPhase: 'idle' });
        setTimeout(() => {
          sendQueued(next);
        }, 0);
        return;
      }
      host.setAppState({ streamingPhase: 'idle' });
    });
    host.sendQueuedMessage.mockImplementation((item: { text: string }) => {
      if (item.text === 'queued user turn') {
        host.setAppState({ streamingPhase: 'waiting' });
      }
      void agent.prompt(item.text);
    });
    const handler = new SessionEventHandler(host);
    const sendQueued = sendQueuedViaHost(host);

    handler.handleEvent(completionEvent(), sendQueued);
    handler.handleEvent(clearedEvent(), sendQueued);
    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(host.sendQueuedMessage).toHaveBeenCalledWith({ text: 'queued user turn' });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.createGoal).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(agent.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    expect(host.sendQueuedMessage).toHaveBeenLastCalledWith({ text: 'Ship queued goal' });
  });

  it('defers queued-goal promotion while a queued message is mid-dispatch', async () => {
    const { host, agent } = makeHost();
    host.state.appState.streamingPhase = 'idle';
    host.state.queuedMessages = [];
    // The queue looks empty and the phase is idle, but a shifted queued message
    // is still awaiting its deferred send. Promotion must not jump ahead of it.
    host.state.queuedMessageDispatchPending = true;
    const handler = new SessionEventHandler(host);

    handler.requestQueuedGoalPromotion();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.createGoal).not.toHaveBeenCalled();

    // Once the queued message has been dispatched, the flag clears and the
    // promotion proceeds on the next retry.
    host.state.queuedMessageDispatchPending = false;
    handler.retryQueuedGoalPromotion();
    await vi.waitFor(() => {
      expect(agent.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
  });

  it('waits for a queued user input drained after compaction before promoting the next queued goal', async () => {
    const { host, agent } = makeHost();
    host.state.appState.isCompacting = true;
    host.state.queuedMessages = [{ text: 'queued user turn' }];
    host.shiftQueuedMessage.mockImplementation(() => host.state.queuedMessages.shift());
    const handler = new SessionEventHandler(host);
    host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
      const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
      Object.assign(host.state.appState, patch);
      if (busyChanged) handler.retryQueuedGoalPromotion();
    });
    host.sendQueuedMessage.mockImplementation((item: { text: string }) => {
      if (item.text === 'queued user turn') {
        host.setAppState({ streamingPhase: 'waiting' });
      }
      void agent.prompt(item.text);
    });
    const sendQueued = sendQueuedViaHost(host);

    handler.requestQueuedGoalPromotion();
    handler.handleEvent(compactionCompletedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(host.sendQueuedMessage).toHaveBeenCalledWith({ text: 'queued user turn' });
    });
    expect(agent.createGoal).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(agent.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    const sendQueuedCalls = host.sendQueuedMessage.mock.calls as Array<[{ text?: string }]>;
    const userMessageIndex = sendQueuedCalls.findIndex(
      ([item]) => item.text === 'queued user turn',
    );
    expect(userMessageIndex).toBeGreaterThanOrEqual(0);
    expect(host.sendQueuedMessage).toHaveBeenLastCalledWith({ text: 'Ship queued goal' });
    const userMessageOrder = host.sendQueuedMessage.mock.invocationCallOrder[userMessageIndex]!;
    const goalCreateOrder = agent.createGoal.mock.invocationCallOrder[0]!;
    expect(userMessageOrder).toBeLessThan(goalCreateOrder);
  });

  it('leaves the queued goal in place when the next goal cannot start', async () => {
    const { host, agent, goalQueue } = makeHost({ createGoalRejects: true });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('create failed'));
    });
    expect(goalQueue.remove).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
    expect(agent.createGoal).toHaveBeenCalledOnce();
  });

  it('retries the queued goal on a later idle event after startup fails', async () => {
    const { host, agent, goalQueue } = makeHost();
    agent.createGoal.mockRejectedValueOnce(new Error('create failed'));
    const handler = new SessionEventHandler(host);
    const sendQueued = sendQueuedViaHost(host);

    handler.handleEvent(completionEvent(), sendQueued);
    handler.handleEvent(clearedEvent(), sendQueued);
    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('create failed'));
    });
    expect(goalQueue.remove).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(agent.createGoal).toHaveBeenCalledTimes(2);
    });
    expect(goalQueue.remove).toHaveBeenCalledWith({ goalId: 'q1' });
    expect(host.sendQueuedMessage).toHaveBeenCalledWith({ text: 'Ship queued goal' });
  });

  it('does not send the queued objective when removal fails after goal creation', async () => {
    const { host, agent, goalQueue } = makeHost();
    goalQueue.remove.mockRejectedValueOnce(new Error('remove failed'));
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('could not be removed'));
    });
    expect(agent.createGoal).toHaveBeenCalledWith({
      objective: 'Ship queued goal',
      replace: false,
    });
    expect(agent.cancelGoal).toHaveBeenCalledOnce();
    expect(goalQueue.restore).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('restores the queued goal and cancels its agent when the runtime binding changes before send', async () => {
    const { host, agent, goalQueue, runtime, setActiveRuntime } = makeHost();
    const replacementAgent = {
      prompt: vi.fn(async (_input: string) => undefined),
      createGoal: vi.fn(async () => fakeGoalSnapshot('Replacement goal', 'active')),
      cancelGoal: vi.fn(async () => fakeGoalSnapshot('Replacement goal', 'active')),
    };
    goalQueue.remove.mockImplementationOnce(async () => {
      setActiveRuntime({
        ...runtime,
        agentId: 'replacement',
        agent: replacementAgent,
      });
      return { goals: [] };
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host));

    await vi.waitFor(() => {
      expect(goalQueue.restore).toHaveBeenCalledWith(queuedGoal);
    });
    expect(agent.cancelGoal).toHaveBeenCalledOnce();
    expect(replacementAgent.cancelGoal).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('restores and cancels when the host becomes busy before sending the promoted goal', async () => {
    const { host, agent, goalQueue } = makeHost();
    goalQueue.remove.mockImplementationOnce(async () => {
      host.setAppState({ streamingPhase: 'waiting' });
      return { goals: [] };
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host));

    await vi.waitFor(() => {
      expect(goalQueue.restore).toHaveBeenCalledWith(queuedGoal);
    });
    expect(agent.cancelGoal).toHaveBeenCalledOnce();
    expect(goalQueue.restore.mock.invocationCallOrder[0]).toBeLessThan(
      agent.cancelGoal.mock.invocationCallOrder[0]!,
    );
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('shows a notice when a blocked goal has queued goals', async () => {
    const { host, agent, goalQueue, requireSession } = makeHost();
    const handler = new SessionEventHandler(host);
    const event = {
      type: 'goal.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: fakeGoalSnapshot('Blocked goal', 'blocked'),
      change: { kind: 'lifecycle', status: 'blocked', reason: 'waiting for access' },
    } as const;

    handler.handleEvent(event, vi.fn());

    await vi.waitFor(() => {
      expect(host.showNotice).toHaveBeenCalledWith(
        'Goal blocked.',
        'The next queued goal will start only after this goal is complete.',
      );
    });
    expect(goalQueue.read).toHaveBeenCalledOnce();
    expect(agent.createGoal).not.toHaveBeenCalled();
    expect(requireSession).not.toHaveBeenCalled();
  });

  it('does not render a duplicate marker for a model-reported blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), vi.fn());

    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('renders a blocked fallback when the model does not explain the blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(addedTranscriptText(host)).toBe('  ◦ Goal blocked');
  });

  it('does not render a blocked fallback after the model explains the blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), vi.fn());
    handler.handleEvent(
      {
        type: 'assistant.delta',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        delta: 'I am blocked because I need credentials.',
      },
      vi.fn(),
    );
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('does not render a blocked fallback after earlier assistant text in the same turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'assistant.delta',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        delta: 'I am blocked because I need credentials.',
      },
      vi.fn(),
    );
    handler.handleEvent(modelBlockedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('does not promote on paused or cancelled updates', async () => {
    const { host, agent } = makeHost();
    const handler = new SessionEventHandler(host);
    const paused = {
      type: 'goal.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: fakeGoalSnapshot('Paused goal', 'paused'),
      change: { kind: 'lifecycle', status: 'paused' },
    } as const;

    handler.handleEvent(paused, vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.createGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });
});

describe('SessionEventHandler notice', () => {
  it('shows a status line without changing streamingPhase', () => {
    const { host } = makeHost();
    host.state.appState.streamingPhase = 'idle';
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'notice',
        sessionId: 's1',
        agentId: 'main',
        message: '会话结束',
        code: 'extension.notify',
      },
      vi.fn(),
    );

    expect(host.showStatus).toHaveBeenCalledExactlyOnceWith('会话结束');
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.appState.streamingPhase).toBe('idle');
  });
});

describe('SessionEventHandler expert team status', () => {
  it('updates the active team and declared roster from a live event', () => {
    const { host, emitEvent } = makeHost();
    const handler = new SessionEventHandler(host);
    const status = {
      pluginId: 'software-company',
      displayName: 'Software Company',
      leadAgentName: 'software-team-lead',
      activatedAt: '2026-07-26T00:00:00.000Z',
      members: [
        { name: 'software-engineer', agentId: 'agent-1', status: 'spawning' as const },
        { name: 'reviewer', status: 'completed' as const },
      ],
    };

    handler.startSubscription();
    emitEvent({
      type: 'session.expert-team.changed',
      sessionId: 's1',
      snapshot: status,
    });

    expect(host.setAppState).toHaveBeenCalledWith({
      expertTeam: status,
      expertTeamMembers: status.members,
    });

    emitEvent({
      type: 'session.expert-team.changed',
      sessionId: 's1',
      snapshot: null,
    });
    expect(host.setAppState).toHaveBeenLastCalledWith({
      expertTeam: null,
      expertTeamMembers: [],
    });
  });
});
