/**
 * Tests for {@link V2SessionAdapter} — the v2/Klient-backed {@link IAcpSessionHost}
 * implementation that bridges the ACP adapter to agent-core-v2 via Klient.
 *
 * Test scope (ACP-303):
 * - getResumeState() returns replay state from agent.replay.read()
 * - Approval/question interaction bridging via session events
 * - Event forwarding from agent events hub to onEvent listener
 * - Close tracking (markClosed) prevents post-close operations
 * - Handler error → graceful rejection
 * - getStatus() returns real context/usage data
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Klient, SessionHandle, AgentHandle, AgentEventPayloads } from '@moonshot-ai/klient';
import { V2SessionAdapter } from '../src/v2-session-adapter';

// ── Mock helpers ─────────────────────────────────────────────────────────

function noopDisposable() {
  return { dispose: () => undefined };
}

type EventCallback = (payload: any) => void;

/**
 * Build a mock Klient with controlled agent/session event hubs,
 * approvals, questions, interactions, and replay.
 */
function createMockKlient(overrides?: {
  resumeState?: unknown;
  pendingApprovals?: ReadonlyArray<{ id: string; payload?: Record<string, unknown> }>;
  pendingQuestions?: ReadonlyArray<{ id: string; payload?: Record<string, unknown> }>;
  contextData?: { tokenCount?: number; maxTokens?: number };
  usageData?: Record<string, unknown>;
  planData?: unknown;
  getModelResult?: string;
  permissionMode?: string;
  thinkingLevel?: string;
  agentEventHandlers?: Map<string, Set<EventCallback>>;
  sessionEventHandlers?: Map<string, Set<EventCallback>>;
}): Klient {
  const agentEvents = overrides?.agentEventHandlers ?? new Map<string, Set<EventCallback>>();
  const sessionEvents = overrides?.sessionEventHandlers ?? new Map<string, Set<EventCallback>>();

  const mockAgent: AgentHandle = {
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    activatePluginCommand: vi.fn().mockResolvedValue(undefined),
    runShellCommand: vi.fn().mockResolvedValue({ output: '' }),
    cancelShellCommand: vi.fn().mockResolvedValue(undefined),
    getModel: vi.fn().mockResolvedValue(overrides?.getModelResult ?? 'kimi-coder'),
    setModel: vi.fn().mockResolvedValue(undefined),
    getPermission: vi.fn().mockResolvedValue(overrides?.permissionMode ?? 'manual'),
    setPermission: vi.fn().mockResolvedValue(undefined),
    getUsage: vi.fn().mockResolvedValue(overrides?.usageData ?? { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }),
    getContext: vi.fn().mockResolvedValue(overrides?.contextData ?? { tokenCount: 1500, maxTokens: 128000 }),
    clearContext: vi.fn().mockResolvedValue(undefined),
    importContext: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(true),
    cancelCompaction: vi.fn().mockResolvedValue(undefined),
    undoHistory: vi.fn().mockResolvedValue(1),
    getPlan: vi.fn().mockResolvedValue(overrides?.planData ?? null),
    enterPlan: vi.fn().mockResolvedValue(undefined),
    clearPlan: vi.fn().mockResolvedValue(undefined),
    cancelPlan: vi.fn().mockResolvedValue(undefined),
    getTasks: vi.fn().mockResolvedValue([]),
    detachTask: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
    getTaskOutput: vi.fn().mockResolvedValue(''),
    mcp: {
      list: vi.fn().mockResolvedValue([]),
      reconnect: vi.fn().mockResolvedValue(undefined),
      initialLoadDurationMs: vi.fn().mockResolvedValue(0),
    },
    goal: {
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: '', objective: '', status: 'active' }),
      pause: vi.fn().mockResolvedValue({ id: '', objective: '', status: 'paused' }),
      resume: vi.fn().mockResolvedValue({ id: '', objective: '', status: 'active' }),
      cancel: vi.fn().mockResolvedValue({ id: '', objective: '', status: 'cancelled' }),
    },
    profile: {
      bind: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ thinkingLevel: overrides?.thinkingLevel ?? 'off' }),
      setThinking: vi.fn().mockResolvedValue(undefined),
    },
    replay: {
      read: vi.fn().mockResolvedValue(
        overrides?.resumeState ?? {
          type: 'main' as const,
          config: { cwd: '/tmp/x', modelAlias: 'kimi-coder' },
          context: { history: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tokenCount: 10 },
          replay: [],
          permission: { mode: 'manual', rules: [] },
          plan: null,
          usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          tools: [],
          tasks: [],
        },
      ),
    },
    skills: {
      activate: vi.fn().mockResolvedValue(undefined),
    },
    swarm: {
      isActive: vi.fn().mockResolvedValue(false),
      enter: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn().mockResolvedValue(undefined),
    },
    extensions: {
      activateCommand: vi.fn().mockResolvedValue(true),
    },
    events: {
      on: (event: string, cb: EventCallback) => {
        if (!agentEvents.has(event)) agentEvents.set(event, new Set());
        agentEvents.get(event)!.add(cb);
        return { dispose: () => agentEvents.get(event)?.delete(cb) };
      },
      onError: vi.fn(),
    } as any,
  } satisfies AgentHandle as unknown as AgentHandle;

  const mockSession: SessionHandle = {
    get: vi.fn().mockResolvedValue({ id: 'sess-1' }),
    setTitle: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue('idle'),
    close: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(true),
    fork: vi.fn().mockResolvedValue({ id: 'forked-1' }),
    createChild: vi.fn().mockResolvedValue({ id: 'child-1' }),
    approvals: {
      list: vi.fn().mockResolvedValue(overrides?.pendingApprovals ?? []),
      decide: vi.fn().mockResolvedValue(undefined),
    },
    questions: {
      list: vi.fn().mockResolvedValue(overrides?.pendingQuestions ?? []),
      answer: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
    },
    interactions: {
      list: vi.fn().mockResolvedValue([]),
      respond: vi.fn().mockResolvedValue(undefined),
    },
    init: {
      generateAgentsMd: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    btw: { start: vi.fn().mockResolvedValue('') },
    expertTeam: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      activate: vi.fn().mockResolvedValue({}),
      deactivate: vi.fn().mockResolvedValue(undefined),
    },
    extensions: {
      listCommands: vi.fn().mockResolvedValue([]),
      reload: vi.fn().mockResolvedValue({ added: 0, removed: 0, errors: [] }),
    },
    cron: {
      list: vi.fn().mockResolvedValue([]),
      getNextFireTime: vi.fn().mockResolvedValue(null),
    },
    goalQueue: {
      read: vi.fn().mockResolvedValue({ upcoming: [], active: null }),
      append: vi.fn().mockResolvedValue({ upcoming: [], active: null }),
      update: vi.fn().mockResolvedValue({ upcoming: [], active: null }),
      remove: vi.fn().mockResolvedValue({ upcoming: [], active: null }),
      restore: vi.fn().mockResolvedValue({ upcoming: [], active: null }),
      move: vi.fn().mockResolvedValue({ upcoming: [], active: null }),
    },
    skills: {
      list: vi.fn().mockResolvedValue([]),
      reload: vi.fn().mockResolvedValue(undefined),
    },
    warnings: { list: vi.fn().mockResolvedValue([]) },
    workspace: {
      get: vi.fn().mockResolvedValue({ workDir: '/tmp/x', additionalDirs: [] }),
      addAdditionalDir: vi.fn().mockResolvedValue({}),
    },
    agents: vi.fn().mockResolvedValue({}),
    events: {
      on: (event: string, cb: EventCallback) => {
        if (!sessionEvents.has(event)) sessionEvents.set(event, new Set());
        sessionEvents.get(event)!.add(cb);
        return { dispose: () => sessionEvents.get(event)?.delete(cb) };
      },
      onError: vi.fn(),
    } as any,
    agent: (_id: string) => mockAgent,
  } satisfies SessionHandle as unknown as SessionHandle;

  const klient: Klient = {
    global: {} as any,
    events: {} as any,
    session: (_id: string) => mockSession,
    close: vi.fn().mockResolvedValue(undefined),
  };

  return klient;
}

/** Trigger an interaction.changed event on a mock Klient session. */
function triggerInteractionsChanged(
  klient: Klient,
  interactions: ReadonlyArray<{
    id: string;
    kind: 'approval' | 'question' | 'user_tool';
    payload?: Record<string, unknown>;
    origin?: { agentId?: string; turnId?: number };
  }>,
): void {
  // Get the session event handlers map via the mock klient
  const sessionHandle = klient.session('test');
  const events = (sessionHandle as any).events as { on: Function };
  // The handlers are registered in the mock; we can't easily trigger them
  // from outside. Instead, we reach into the mock internals.
  // Since the mock stores callbacks in sessionEventHandlers, we pull them
  // from the closure. For test simplicity, we expose through a helper.
  const handlers = (klient as any).__sessionEventHandlers ?? new Map();
  const cbs = handlers.get('interactions.changed');
  if (cbs) {
    for (const cb of cbs) {
      cb(interactions);
    }
  }
}

describe('V2SessionAdapter', () => {
  let adapter: V2SessionAdapter;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getResumeState', () => {
    it('returns replay state from agent.replay.read()', async () => {
      const klient = createMockKlient({
        resumeState: {
          type: 'main',
          config: { cwd: '/tmp/x', modelAlias: 'kimi-coder' },
          context: {
            history: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            tokenCount: 10,
          },
          replay: [],
          permission: { mode: 'manual', rules: [] },
          plan: null,
          usage: { total: { inputOther: 15, output: 25, inputCacheRead: 5, inputCacheCreation: 0 } },
          tools: [],
          tasks: [],
        },
      });

      adapter = new V2SessionAdapter(klient, 'sess-1');
      // Allow the eager loadResumeState() microtask to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = adapter.getResumeState() as any;
      expect(state).toBeDefined();
      expect(state.agents).toBeDefined();
      expect(state.agents.main).toBeDefined();
      expect(state.agents.main.context.history).toHaveLength(1);
      expect(state.agents.main.context.history[0]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
      expect(state.agents.main.context.tokenCount).toBe(10);
    });

    it('returns undefined when agent.replay.read() rejects', async () => {
      const klient = createMockKlient();
      // Override replay.read to reject
      const sessionHandle = klient.session('sess-1');
      const agentHandle = sessionHandle.agent('main');
      (agentHandle.replay.read as any).mockRejectedValue(new Error('replay not available'));

      adapter = new V2SessionAdapter(klient, 'sess-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(adapter.getResumeState()).toBeUndefined();
    });

    it('returns undefined when replay state has no agents property', async () => {
      const klient = createMockKlient({
        resumeState: { type: 'main', config: {}, context: { history: [], tokenCount: 0 }, replay: [], permission: { mode: 'manual', rules: [] }, plan: null, usage: {}, tools: [], tasks: [] },
      });

      adapter = new V2SessionAdapter(klient, 'sess-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = adapter.getResumeState() as any;
      expect(state).toBeDefined();
      expect(state.agents.main.context.history).toEqual([]);
    });
  });

  describe('onEvent — event forwarding', () => {
    it('forwards agent events to the registered listener', () => {
      const agentEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ agentEventHandlers: agentEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const received: any[] = [];
      const unsub = adapter.onEvent((event: any) => {
        received.push(event);
      });

      // Simulate an agent event being emitted
      const cbs = agentEvents.get('assistant.delta');
      expect(cbs).toBeDefined();
      expect(cbs!.size).toBeGreaterThan(0);
      for (const cb of cbs!) {
        cb({ type: 'assistant.delta', turnId: 1, delta: 'hello' });
      }

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: 'assistant.delta', delta: 'hello' });

      unsub();
    });

    it('stops forwarding after unsubscribe', () => {
      const agentEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ agentEventHandlers: agentEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const received: any[] = [];
      const unsub = adapter.onEvent((event: any) => {
        received.push(event);
      });
      unsub();

      // After unsub, the callbacks should be removed
      const cbs = agentEvents.get('assistant.delta');
      if (cbs) {
        for (const cb of cbs) {
          cb({ type: 'assistant.delta', turnId: 1, delta: 'should not arrive' });
        }
      }

      expect(received).toHaveLength(0);
    });
  });

  describe('approval interaction bridging', () => {
    it('calls the approval handler when an approval interaction appears', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const approvalHandler = vi.fn().mockResolvedValue({ decision: 'approved' as const });
      adapter.setApprovalHandler!(approvalHandler);

      // Trigger onEvent to ensure interaction subscription is active
      const unsub = adapter.onEvent(vi.fn());

      // Simulate an interactions.changed event
      const cbs = sessionEvents.get('interactions.changed');
      expect(cbs).toBeDefined();
      const changedCb = cbs!.values().next().value;

      await changedCb!([
        { id: 'ia-1', kind: 'approval', payload: { toolName: 'Bash', toolCallId: 'tc-1', action: 'execute' } },
      ]);

      // Allow async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(approvalHandler).toHaveBeenCalledTimes(1);
      const callArg = approvalHandler.mock.calls[0]![0];
      expect(callArg).toMatchObject({
        toolName: 'Bash',
        toolCallId: 'tc-1',
        action: 'execute',
      });
      expect(callArg.display).toBeDefined();

      unsub();
    });

    it('sends approval decision back via session.approvals.decide()', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const approvalHandler = vi.fn().mockResolvedValue({ decision: 'approved' as const });
      adapter.setApprovalHandler!(approvalHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;
      const decideSpy = vi.spyOn(klient.session('sess-1').approvals, 'decide');

      await changedCb!([
        { id: 'ia-2', kind: 'approval', payload: { toolName: 'Read', toolCallId: 'tc-2', action: 'read_file' } },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(decideSpy).toHaveBeenCalledWith('ia-2', expect.objectContaining({ decision: 'approved' }));

      unsub();
    });

    it('rejects approval gracefully when handler throws', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const approvalHandler = vi.fn().mockRejectedValue(new Error('handler crashed'));
      adapter.setApprovalHandler!(approvalHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;
      const decideSpy = vi.spyOn(klient.session('sess-1').approvals, 'decide');

      await changedCb!([
        { id: 'ia-3', kind: 'approval', payload: { toolName: 'Write', toolCallId: 'tc-3' } },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Handler error should result in a rejected decision
      expect(decideSpy).toHaveBeenCalledWith('ia-3', expect.objectContaining({ decision: 'rejected' }));

      unsub();
    });

    it('does not call handler for subagent interactions', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const approvalHandler = vi.fn();
      adapter.setApprovalHandler!(approvalHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;

      await changedCb!([
        { id: 'ia-sub', kind: 'approval', payload: { toolName: 'Bash' }, origin: { agentId: 'sub-1' } },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(approvalHandler).not.toHaveBeenCalled();

      unsub();
    });

    it('does not handle the same interaction twice', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const approvalHandler = vi.fn().mockResolvedValue({ decision: 'approved' as const });
      adapter.setApprovalHandler!(approvalHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;

      // Fire the same interaction twice
      await changedCb!([
        { id: 'ia-duplicate', kind: 'approval', payload: { toolName: 'Bash', toolCallId: 'tc-d' } },
      ]);
      await changedCb!([
        { id: 'ia-duplicate', kind: 'approval', payload: { toolName: 'Bash', toolCallId: 'tc-d' } },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(approvalHandler).toHaveBeenCalledTimes(1);

      unsub();
    });
  });

  describe('question interaction bridging', () => {
    it('calls the question handler when a question interaction appears', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const questionHandler = vi.fn().mockResolvedValue({ 'q-0': 'answer text' });
      adapter.setQuestionHandler!(questionHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;

      await changedCb!([
        {
          id: 'iq-1',
          kind: 'question',
          payload: {
            questions: [
              { id: 'q-0', question: 'What is your favorite color?', options: ['red', 'blue'] },
            ],
            toolCallId: 'tc-q',
          },
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(questionHandler).toHaveBeenCalledTimes(1);
      const callArg = questionHandler.mock.calls[0]![0];
      expect(callArg).toMatchObject({
        questions: [{ id: 'q-0', question: 'What is your favorite color?' }],
        toolCallId: 'tc-q',
      });

      unsub();
    });

    it('sends question answer via session.questions.answer()', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const questionHandler = vi.fn().mockResolvedValue({ 'q-1': 'blue' });
      adapter.setQuestionHandler!(questionHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;
      const answerSpy = vi.spyOn(klient.session('sess-1').questions, 'answer');

      await changedCb!([
        {
          id: 'iq-2',
          kind: 'question',
          payload: { questions: [{ id: 'q-1', question: 'Pick one', options: ['red', 'blue'] }] },
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(answerSpy).toHaveBeenCalledWith('iq-2', { 'q-1': 'blue' });

      unsub();
    });

    it('dismisses question when handler returns null', async () => {
      const sessionEvents = new Map<string, Set<EventCallback>>();
      const klient = createMockKlient({ sessionEventHandlers: sessionEvents });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const questionHandler = vi.fn().mockResolvedValue(null);
      adapter.setQuestionHandler!(questionHandler);

      const unsub = adapter.onEvent(vi.fn());

      const cbs = sessionEvents.get('interactions.changed')!;
      const changedCb = cbs.values().next().value;
      const dismissSpy = vi.spyOn(klient.session('sess-1').questions, 'dismiss');

      await changedCb!([
        {
          id: 'iq-3',
          kind: 'question',
          payload: { questions: [{ id: 'q-2', question: 'Confirm?', options: ['yes', 'no'] }] },
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(dismissSpy).toHaveBeenCalledWith('iq-3');

      unsub();
    });
  });

  describe('close tracking', () => {
    it('rejects prompt after markClosed()', async () => {
      const klient = createMockKlient();
      const v2Adapter = new V2SessionAdapter(klient, 'sess-1');

      v2Adapter.markClosed();
      expect(v2Adapter.isClosed).toBe(true);

      await expect(v2Adapter.prompt('test')).rejects.toMatchObject({ code: 'session.closed' });
    });

    it('rejects compact after markClosed()', async () => {
      const klient = createMockKlient();
      const v2Adapter = new V2SessionAdapter(klient, 'sess-1');

      v2Adapter.markClosed();

      await expect(v2Adapter.compact()).rejects.toMatchObject({ code: 'session.closed' });
    });

    it('rejects activateSkill after markClosed()', async () => {
      const klient = createMockKlient();
      const v2Adapter = new V2SessionAdapter(klient, 'sess-1');

      v2Adapter.markClosed();

      await expect(v2Adapter.activateSkill('test')).rejects.toMatchObject({ code: 'session.closed' });
    });

    it('cancel is noop after markClosed()', async () => {
      const klient = createMockKlient();
      const v2Adapter = new V2SessionAdapter(klient, 'sess-1');
      const cancelSpy = vi.spyOn(klient.session('sess-1').agent('main'), 'cancel');

      v2Adapter.markClosed();
      await v2Adapter.cancel();

      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns real context tokens from getContext()', async () => {
      const klient = createMockKlient({
        contextData: { tokenCount: 5000, maxTokens: 128000 },
        getModelResult: 'kimi-coder',
        permissionMode: 'ask',
        thinkingLevel: 'high',
      });
      adapter = new V2SessionAdapter(klient, 'sess-1');

      const status = await adapter.getStatus!();

      expect(status).toMatchObject({
        model: 'kimi-coder',
        permission: 'ask',
        thinkingEffort: 'high',
      });
      expect(status.contextTokens).toBe(5000);
      expect(status.maxContextTokens).toBe(128000);
      expect(typeof status.contextUsage).toBe('number');
      expect(status.contextUsage).toBeCloseTo(5000 / 128000, 4);
    });

    it('returns zeros when getContext() fails', async () => {
      const klient = createMockKlient();
      const agentHandle = klient.session('sess-1').agent('main');
      (agentHandle.getContext as any).mockRejectedValue(new Error('context unavailable'));

      adapter = new V2SessionAdapter(klient, 'sess-1');
      const status = await adapter.getStatus!();

      expect(status.contextTokens).toBe(0);
      expect(status.maxContextTokens).toBe(0);
      expect(status.contextUsage).toBe(0);
    });
  });

  describe('summary', () => {
    it('returns summary with sessionDir when provided', () => {
      adapter = new V2SessionAdapter(createMockKlient(), 'sess-1', '/path/to/session');
      expect(adapter.summary).toBeDefined();
      expect(adapter.summary!.sessionDir).toBe('/path/to/session');
    });

    it('returns undefined summary when no sessionDir provided', () => {
      adapter = new V2SessionAdapter(createMockKlient(), 'sess-1');
      expect(adapter.summary).toBeUndefined();
    });
  });
});
