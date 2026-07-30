// Scenario: the desktop product transport exposes kimi-web contracts through
// the browser mock. Exercises public KimiWebApi methods with only the
// other-process bridge stubbed. Run with `pnpm --filter @moonshot-ai/kimi-web test`.
// Dispatch coverage against the real ProductFacade lives in
// test/product-method-coverage.test.ts (kept out of src/ for vue-tsc).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitialState, reduceAppEvent } from '../daemon/eventReducer';
import type { KimiClientState } from '../daemon/eventReducer';
import { toAppEvent } from '../daemon/mappers';
import type { WireEvent } from '../daemon/wire';
import type { AppEvent, AppSession, AppSessionSnapshot, KimiEventHandlers, KimiEventMeta } from '../types';
import { createWailsKimiWebApi } from './client';
import { isDesktopShellAvailable, isDesktopTransportEnabled } from './index';
import { MockDesktopBridge } from './mock';
import type { DesktopBridge, ProductEventPayload, ProductStreamCursor } from './types';

interface Received {
  event: AppEvent;
  meta: KimiEventMeta;
}

function connect(bridge: MockDesktopBridge) {
  const api = createWailsKimiWebApi(bridge);
  const received: Received[] = [];
  const resyncs: Array<{ sessionId: string; seq: number }> = [];
  const conn = api.connectEvents({
    onEvent: (event, meta) => received.push({ event, meta }),
    onResync: (sessionId, seq) => resyncs.push({ sessionId, seq }),
    onError: () => {},
    onConnectionChange: () => {},
  });
  return { api, received, resyncs, conn };
}

/** Fold received AppEvents through the REAL reducer the transcript UI uses. */
function fold(session: AppSession, received: Received[]): KimiClientState {
  let state = createInitialState();
  state = { ...state, sessions: [session] };
  for (const { event, meta } of received) {
    state = reduceAppEvent(state, event, { sessionId: meta.sessionId, seq: meta.seq });
  }
  return state;
}

/** No-op event handlers; individual tests override the fields they assert on. */
function noopHandlers(overrides?: Partial<KimiEventHandlers>): KimiEventHandlers {
  return {
    onEvent: () => {},
    onResync: () => {},
    onError: () => {},
    onConnectionChange: () => {},
    ...overrides,
  };
}

interface RecordingBridge {
  bridge: DesktopBridge;
  subscribes: Array<{ sessionId: string; agentId: string; cursor?: ProductStreamCursor }>;
  unsubscribes: Array<{ sessionId: string; agentId: string }>;
  emit: (event: unknown) => void;
  setFailSubscribe: (fail: boolean) => void;
}

/**
 * A minimal DesktopBridge that records subscribe/unsubscribe calls and lets a
 * test push arbitrary product frames (including `resync_required`) to the
 * registered listener — precise control over the connectEvents wiring the full
 * mock cannot give.
 */
function makeRecordingBridge(opts?: { failSubscribe?: boolean }): RecordingBridge {
  let listener: ((payload: ProductEventPayload) => void) | undefined;
  const subscribes: RecordingBridge['subscribes'] = [];
  const unsubscribes: RecordingBridge['unsubscribes'] = [];
  let failSubscribe = opts?.failSubscribe ?? false;
  const bridge = {
    kind: 'mock' as const,
    Hello: async () => ({}),
    ListSessions: async () => ({ items: [] }),
    CreateSession: async () => ({ sessionId: 's', agentId: 'main' }),
    Submit: async () => undefined,
    Cancel: async () => undefined,
    ProductCall: async () =>
      JSON.stringify({ code: 0, msg: 'success', data: {}, request_id: 'r' }),
    ProductSubscribe: async (
      sessionId: string,
      agentId: string,
      cursor?: ProductStreamCursor,
    ): Promise<void> => {
      subscribes.push({ sessionId, agentId, cursor });
      if (failSubscribe) throw new Error('subscribe boom');
    },
    ProductUnsubscribe: async (sessionId: string, agentId: string): Promise<void> => {
      unsubscribes.push({ sessionId, agentId });
    },
    onEvent: () => () => {},
    onProductEvent: (callback: (payload: ProductEventPayload) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as DesktopBridge;
  return {
    bridge,
    subscribes,
    unsubscribes,
    emit: (event: unknown) =>
      listener?.({ sessionId: 's-1', agentId: 'main', event } as ProductEventPayload),
    setFailSubscribe: (fail: boolean) => {
      failSubscribe = fail;
    },
  };
}

/** A projected work_changed frame at a given seq (drives cursor advancement). */
function workFrame(seq: number, sessionId = 's-1'): unknown {
  return {
    type: 'event.session.work_changed',
    seq,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: { busy: false, main_turn_active: false, last_turn_reason: 'completed' },
  };
}

describe('WailsKimiWebApi (desktop product transport, first slice)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function createSession(api: ReturnType<typeof createWailsKimiWebApi>): Promise<AppSession> {
    const pending = api.createSession({ cwd: '/mock', title: 'Demo' });
    await vi.advanceTimersByTimeAsync(100);
    return pending;
  }

  it('createSession / listSessions map the kimi-web wire to App shapes', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const session = await createSession(api);
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('Demo');
    expect(session.cwd).toBe('/mock');
    expect(session.busy).toBe(false);

    const pendingList = api.listSessions();
    await vi.advanceTimersByTimeAsync(100);
    const page = await pendingList;
    expect(page.hasMore).toBe(false);
    expect(page.items.map((item) => item.id)).toContain(session.id);
  });

  it('submitPrompt returns the mapped prompt result', async () => {
    const bridge = new MockDesktopBridge();
    const { api } = connect(bridge);
    const session = await createSession(api);

    const pending = api.submitPrompt(session.id, { content: [{ type: 'text', text: 'hello' }] });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.promptId).toBeTruthy();
    expect(result.userMessageId).toBeTruthy();
    expect(result.status).toBe('running');
  });

  it('streams a turn through toAppEvent into the real transcript reducer', async () => {
    const bridge = new MockDesktopBridge();
    const { api, received, conn } = connect(bridge);
    const session = await createSession(api);
    conn.subscribe(session.id);

    const pending = api.submitPrompt(session.id, { content: [{ type: 'text', text: 'hello' }] });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    await vi.runAllTimersAsync();

    const state = fold(session, received);

    // The session ends idle with a completed turn reason.
    const reduced = state.sessions.find((s) => s.id === session.id);
    expect(reduced?.busy).toBe(false);
    expect(reduced?.lastTurnReason).toBe('completed');

    const msgs = state.messagesBySession[session.id] ?? [];
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();

    // Streamed assistant text accumulated via assistantDelta.
    const text = assistant?.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && text.text).toContain('Sure');

    // A tool card with accumulated output lines from event.tool.output.
    const toolUse = assistant?.content.find((c) => c.type === 'toolUse');
    expect(toolUse?.type === 'toolUse' && toolUse.toolName).toBe('Bash');
    expect(toolUse?.type === 'toolUse' && toolUse.outputLines?.join('')).toContain('hello from the mock engine');

    // The tool result message rendered as its own bubble.
    const toolResult = msgs.find((m) => m.role === 'tool');
    expect(toolResult).toBeTruthy();
    expect(toolResult?.content.some((c) => c.type === 'toolResult')).toBe(true);
  });

  it('abortPrompt maps the wire result and the connection aborts', async () => {
    const bridge = new MockDesktopBridge();
    const { api } = connect(bridge);
    const session = await createSession(api);

    const pending = api.abortPrompt(session.id, 'pr-1');
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.aborted).toBe(true);
  });

  it('respondApproval / respondQuestion resolve and emit resolved AppEvents', async () => {
    const bridge = new MockDesktopBridge();
    const { api, received, conn } = connect(bridge);
    const session = await createSession(api);
    // Product frames are delivered only to a subscribed session (unsubscribe stops them).
    conn.subscribe(session.id);
    await vi.advanceTimersByTimeAsync(1);

    const approvalPending = api.respondApproval(session.id, 'ap-1', { decision: 'approved' });
    await vi.advanceTimersByTimeAsync(100);
    const approval = await approvalPending;
    expect(approval.resolved).toBe(true);

    const questionPending = api.respondQuestion(session.id, 'q-1', { answers: {} });
    await vi.advanceTimersByTimeAsync(100);
    const question = await questionPending;
    expect(question.resolved).toBe(true);

    const types = received.map((entry) => entry.event.type);
    expect(types).toContain('approvalResolved');
    expect(types).toContain('questionAnswered');
  });

  it('maps approval/question request WireEvents into reducer state (same pipeline)', async () => {
    // Focused proof that the wire→AppEvent→reducer path connectEvents relies on
    // renders approval + question prompts (the requested direction).
    const sessionId = 's-1';
    const approvalWire = {
      type: 'event.approval.requested',
      seq: 1,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        approval_id: 'ap-1',
        session_id: sessionId,
        tool_call_id: 'tc-1',
        tool_name: 'Bash',
        action: 'run',
        expires_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    } as unknown as WireEvent;
    const questionWire = {
      type: 'event.question.requested',
      seq: 2,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        question_id: 'q-1',
        session_id: sessionId,
        questions: [{ id: 'q-1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        created_at: new Date().toISOString(),
      },
    } as unknown as WireEvent;

    let state = createInitialState();
    state = reduceAppEvent(state, toAppEvent(approvalWire), { sessionId, seq: 1 });
    state = reduceAppEvent(state, toAppEvent(questionWire), { sessionId, seq: 2 });

    expect((state.approvalsBySession[sessionId] ?? []).map((a) => a.approvalId)).toContain('ap-1');
    expect((state.questionsBySession[sessionId] ?? []).map((q) => q.questionId)).toContain('q-1');
  });

  it('methods outside the implemented slices throw a clear error', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    expect(() => api.listTerminals('s-1')).toThrow(/not yet supported/);
    expect(() => api.uploadFile({ file: new Blob([]) })).toThrow(/not yet supported/);
  });

  // Requirement: catch "the client calls a product method the real sidecar
  // never registered" — covered by test/product-method-coverage.test.ts, which
  // statically compares client.ts `this.call` names against the facade cases.

  it('drives the Slice 2 session-control methods through the product transport', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    // Seed one prompt so steer has an id and undo has history to cut.
    const submitPending = api.submitPrompt(session.id, {
      content: [{ type: 'text', text: 'undo me' }],
    });
    await vi.advanceTimersByTimeAsync(100);
    const submitted = await submitPending;

    const steerPending = api.steerPrompts(session.id, [submitted.promptId]);
    await vi.advanceTimersByTimeAsync(100);
    await expect(steerPending).resolves.toEqual({
      steered: true,
      promptIds: [submitted.promptId],
    });

    const abortPending = api.abortSession(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(abortPending).resolves.toEqual({ aborted: true });

    const compactPending = api.compactSession(session.id, 'squash the history');
    await vi.advanceTimersByTimeAsync(100);
    await expect(compactPending).resolves.toBeUndefined();

    const undoPending = api.undoSession(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(undoPending).resolves.toBeUndefined();
    const afterUndoPending = api.listMessages(session.id);
    await vi.advanceTimersByTimeAsync(100);
    const afterUndo = await afterUndoPending;
    expect(
      afterUndo.items.some((m) =>
        m.content.some((c) => c.type === 'text' && c.text.includes('undo me')),
      ),
    ).toBe(false);

    const btwPending = api.startBtw(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(btwPending).resolves.toEqual({ agentId: `mock-btw-${session.id}` });
  });

  it('forks and creates child sessions with the parent marker', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const forkPending = api.forkSession(session.id, { title: 'Forked copy' });
    await vi.advanceTimersByTimeAsync(100);
    const forked = await forkPending;
    expect(forked.id).not.toBe(session.id);
    expect(forked.title).toBe('Forked copy');
    expect(forked.cwd).toBe(session.cwd);
    expect(forked.parentSessionId).toBeUndefined();

    const childPending = api.createChildSession(session.id, { title: 'Side chat' });
    await vi.advanceTimersByTimeAsync(100);
    const child = await childPending;
    expect(child.parentSessionId).toBe(session.id);

    const childrenPending = api.listChildSessions(session.id);
    await vi.advanceTimersByTimeAsync(100);
    const children = await childrenPending;
    expect(children.map((s) => s.id)).toContain(child.id);
    expect(children.map((s) => s.id)).not.toContain(forked.id);
  });

  it('session-control methods reject for an unknown session', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const forkRejection = expect(api.forkSession('missing-session')).rejects.toThrow(
      /does not exist/,
    );
    const btwRejection = expect(api.startBtw('missing-session')).rejects.toThrow(
      /does not exist/,
    );
    const abortRejection = expect(api.abortSession('missing-session')).rejects.toThrow(
      /does not exist/,
    );
    await vi.advanceTimersByTimeAsync(100);
    await forkRejection;
    await btwRejection;
    await abortRejection;
  });

  it('getSession / listMessages return mapped App shapes', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const getPending = api.getSession(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(getPending).resolves.toMatchObject({
      id: session.id,
      title: 'Demo',
      cwd: '/mock',
    });

    const submitPending = api.submitPrompt(session.id, {
      content: [{ type: 'text', text: 'hello history' }],
    });
    await vi.advanceTimersByTimeAsync(100);
    await submitPending;

    const listPending = api.listMessages(session.id);
    await vi.advanceTimersByTimeAsync(100);
    const page = await listPending;
    expect(page.hasMore).toBe(false);
    expect(page.items.some((m) => m.role === 'user')).toBe(true);
    expect(page.items.some((m) => m.content.some((c) => c.type === 'text' && c.text.includes('hello history')))).toBe(
      true,
    );
  });

  it('dismissQuestion accepts the 40909 success envelope', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);
    bridge.seedPendingQuestion(session.id, 'q-dismiss-1');

    const pending = api.dismissQuestion(session.id, 'q-dismiss-1');
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.dismissed).toBe(true);
    expect(result.dismissedAt).toBeTruthy();
  });

  it('getTask / cancelTask cover success and already-finished', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);
    const now = new Date().toISOString();
    bridge.seedTask(session.id, {
      id: 'task-1',
      session_id: session.id,
      kind: 'bash',
      description: 'echo hello',
      status: 'running',
      command: 'echo hello',
      created_at: now,
      started_at: now,
      output_preview: 'hello\n',
    });

    const getPending = api.getTask(session.id, 'task-1', { withOutput: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(getPending).resolves.toMatchObject({
      id: 'task-1',
      status: 'running',
      outputPreview: 'hello\n',
    });

    const cancelPending = api.cancelTask(session.id, 'task-1');
    await vi.advanceTimersByTimeAsync(100);
    await expect(cancelPending).resolves.toEqual({ cancelled: true });

    const cancelAgain = expect(api.cancelTask(session.id, 'task-1')).rejects.toThrow(/40904/);
    await vi.advanceTimersByTimeAsync(100);
    await cancelAgain;
  });

  it('uses the desktop-owned OAuth flow instead of the daemon login', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const startPending = api.startOAuthLogin();
    const pollPending = api.pollOAuthLogin();
    const refreshPending = api.refreshOAuthProviderModels();
    await vi.advanceTimersByTimeAsync(100);

    await expect(startPending).resolves.toMatchObject({
      flowId: 'mock-oauth-flow',
      provider: 'kimi',
      status: 'authenticated',
    });
    await expect(pollPending).resolves.toMatchObject({
      flowId: 'mock-oauth-flow',
      status: 'authenticated',
    });
    await expect(refreshPending).resolves.toEqual({
      changed: [],
      unchanged: ['kimi'],
      failed: [],
    });

    const logoutPending = api.logout();
    await vi.advanceTimersByTimeAsync(100);
    await expect(logoutPending).resolves.toEqual({ loggedOut: true });
  });

  it('makes a newly configured provider model available to the desktop picker', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const createPending = api.createProvider({
      id: 'deepseek',
      type: 'openai',
      apiKey: 'YOUR_API_KEY',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
      models: [
        {
          model: 'deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          maxContextSize: 1_000_000,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(createPending).resolves.toMatchObject({
      id: 'deepseek',
      status: 'connected',
    });

    const modelsPending = api.listModels();
    await vi.advanceTimersByTimeAsync(100);
    const models = await modelsPending;
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          maxContextSize: 1_000_000,
        }),
      ]),
    );
  });

  it('updates an existing provider through the desktop transport', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const replacePending = api.replaceProvider('mock', {
      id: 'custom-openai',
      type: 'openai_responses',
      baseUrl: 'https://example.test/v1',
      models: [
        {
          model: 'example-model',
          displayName: 'Example Model',
          maxContextSize: 64_000,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(replacePending).resolves.toMatchObject({
      id: 'custom-openai',
      type: 'openai_responses',
      hasApiKey: true,
    });
  });

  it('refreshes one provider through the desktop transport', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const pending = api.refreshProvider('mock');
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual({
      changed: [],
      unchanged: ['mock'],
      failed: [],
    });
  });

  it('switches the session model through updateSession and echoes it from status', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);
    expect(session.model).toBe('mock-model');

    const updatePending = api.updateSession(session.id, {
      model: 'mock-model-mini',
      thinking: 'high',
    });
    await vi.advanceTimersByTimeAsync(100);
    const updated = await updatePending;
    expect(updated.model).toBe('mock-model-mini');

    const statusPending = api.getSessionStatus(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(statusPending).resolves.toMatchObject({
      model: 'mock-model-mini',
      thinkingEffort: 'high',
    });
  });

  it('creates a session with the draft model from agent_config', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const pending = api.createSession({
      cwd: '/mock',
      title: 'Draft pick',
      model: 'mock-model-mini',
    });
    await vi.advanceTimersByTimeAsync(100);
    const session = await pending;
    expect(session.model).toBe('mock-model-mini');
  });

  it('lists and activates an expert team on the desktop transport', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const listPending = api.listExpertTeams(session.id);
    await vi.advanceTimersByTimeAsync(100);
    const teams = await listPending;
    expect(teams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'mock-experts',
          displayName: 'Mock Expert Team',
          leadAgentName: 'lead',
        }),
      ]),
    );

    const initialPending = api.getExpertTeam(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(initialPending).resolves.toBeNull();

    const activatePending = api.activateExpertTeam(session.id, 'mock-experts');
    await vi.advanceTimersByTimeAsync(100);
    await expect(activatePending).resolves.toMatchObject({
      pluginId: 'mock-experts',
      displayName: 'Mock Expert Team',
      leadAgentName: 'lead',
    });

    const activePending = api.getExpertTeam(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(activePending).resolves.toMatchObject({ pluginId: 'mock-experts' });

    const deactivatePending = api.deactivateExpertTeam(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await deactivatePending;
    const clearedPending = api.getExpertTeam(session.id);
    await vi.advanceTimersByTimeAsync(100);
    await expect(clearedPending).resolves.toBeNull();
  });

  it('selects the desktop transport automatically inside Wails', () => {
    vi.stubGlobal('window', { go: { main: { App: {} } }, runtime: {} });
    vi.stubGlobal('location', { search: '' });
    expect(isDesktopShellAvailable()).toBe(true);
    expect(isDesktopTransportEnabled()).toBe(true);

    vi.stubGlobal('location', { search: '?desktop_transport=0' });
    expect(isDesktopShellAvailable()).toBe(true);
    expect(isDesktopTransportEnabled()).toBe(false);
  });

  // Slice 2 clean-boot methods (docs §12.3). Adding each as a real class method
  // bypasses the Proxy's synchronous "not yet supported" throw, so every boot
  // call below must RESOLVE from the mock (never throw synchronously, never
  // reject) — this is exactly what lets ?desktop_transport=1 boot cleanly.
  it('boots cleanly: all 8 read-only boot methods resolve from the mock', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const authPending = api.getAuth();
    const healthPending = api.getHealth();
    const metaPending = api.getMeta();
    const configPending = api.getConfig();
    const workspacesPending = api.listWorkspaces();
    const fsHomePending = api.getFsHome();
    const modelsPending = api.listModels();
    const snapshotPending = api.getSessionSnapshot(session.id);
    await vi.advanceTimersByTimeAsync(100);

    const auth = await authPending;
    expect(auth.ready).toBe(true);
    expect(auth.providersCount).toBe(1);
    expect(auth.defaultModel).toBe('mock-model');
    expect(auth.managedProvider).toEqual({ status: 'connected' });

    const health = await healthPending;
    expect(health).toEqual({ status: 'ok', uptimeSec: 0 });

    const meta = await metaPending;
    expect(meta.backend).toBe('v2');
    expect(meta.serverId).toBe('mock-server');
    expect(meta.openInApps).toEqual([]);
    expect(meta.dangerousBypassAuth).toBe(false);

    const config = await configPending;
    expect(config.defaultModel).toBe('mock-model');
    expect(config.providers['mock']?.hasApiKey).toBe(true);

    const workspaces = await workspacesPending;
    expect(workspaces.map((w) => w.id)).toContain('mock-workspace');
    expect(workspaces[0]?.root).toBe('/mock');

    const fsHome = await fsHomePending;
    expect(fsHome.home).toBe('/mock');
    expect(fsHome.recentRoots).toContain('/mock');

    const models = await modelsPending;
    expect(models.map((m) => m.id)).toContain('mock-model');
    expect(models[0]?.maxContextSize).toBe(128000);

    const snapshot = await snapshotPending;
    expect(snapshot.session.id).toBe(session.id);
    expect(snapshot.asOfSeq).toBe(0);
    expect(snapshot.epoch).toBe('mock-epoch');
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.inFlightTurn).toBeNull();
    expect(snapshot.subagents).toEqual([]);
    expect(snapshot.pendingApprovals).toEqual([]);
    expect(snapshot.pendingQuestions).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Slice 3 — event convergence: resume cursor, unsubscribe, resync, reconnect.
  // ---------------------------------------------------------------------------

  it('forwards the resume cursor to the bridge on subscribe', async () => {
    const rec = makeRecordingBridge();
    const api = createWailsKimiWebApi(rec.bridge);
    const conn = api.connectEvents(noopHandlers());

    conn.subscribe('s-1', { seq: 7, epoch: 'ep-1' });
    await vi.advanceTimersByTimeAsync(1);

    expect(rec.subscribes).toEqual([
      { sessionId: 's-1', agentId: 'main', cursor: { epoch: 'ep-1', afterSeq: 7 } },
    ]);
  });

  it('resumes at the seeded snapshot watermark', async () => {
    const rec = makeRecordingBridge();
    const api = createWailsKimiWebApi(rec.bridge);
    const conn = api.connectEvents(noopHandlers());

    conn.seedSnapshot('s-1', { asOfSeq: 5, epoch: 'ep-2' } as unknown as AppSessionSnapshot);
    // No explicit cursor: the seeded watermark must drive the subscription.
    conn.subscribe('s-1');
    await vi.advanceTimersByTimeAsync(1);

    expect(rec.subscribes[0]?.cursor).toEqual({ epoch: 'ep-2', afterSeq: 5 });
  });

  it('advances the cursor from live frames and reconnect resumes past them', async () => {
    const rec = makeRecordingBridge();
    const api = createWailsKimiWebApi(rec.bridge);
    const conn = api.connectEvents(noopHandlers());

    conn.subscribe('s-1', { seq: 0, epoch: 'ep-1' });
    await vi.advanceTimersByTimeAsync(1);
    rec.emit(workFrame(3));

    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);

    expect(rec.subscribes.at(-1)?.cursor).toEqual({ epoch: 'ep-1', afterSeq: 3 });
  });

  it('handles a resync_required control frame and adopts its watermark', async () => {
    const onResync = vi.fn();
    const rec = makeRecordingBridge();
    const api = createWailsKimiWebApi(rec.bridge);
    const conn = api.connectEvents(noopHandlers({ onResync }));

    conn.subscribe('s-1', { seq: 0, epoch: 'ep-1' });
    await vi.advanceTimersByTimeAsync(1);
    rec.emit({
      type: 'resync_required',
      timestamp: new Date().toISOString(),
      payload: { session_id: 's-1', reason: 'buffer_overflow', current_seq: 9, epoch: 'ep-2' },
    });

    expect(onResync).toHaveBeenCalledWith('s-1', 9, 'ep-2');

    // The adopted watermark drives the next (re)subscription.
    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.subscribes.at(-1)?.cursor).toEqual({ epoch: 'ep-2', afterSeq: 9 });
  });

  it('unsubscribe detaches the bridge stream but keeps the cursor', async () => {
    const rec = makeRecordingBridge();
    const api = createWailsKimiWebApi(rec.bridge);
    const conn = api.connectEvents(noopHandlers());

    conn.subscribe('s-1', { seq: 2, epoch: 'ep-1' });
    await vi.advanceTimersByTimeAsync(1);
    conn.unsubscribe('s-1');
    await vi.advanceTimersByTimeAsync(1);

    expect(rec.unsubscribes).toEqual([{ sessionId: 's-1', agentId: 'main' }]);
    // reconnect() only resumes still-subscribed sessions — the detached one stays off.
    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.subscribes).toHaveLength(1);
  });

  it('reflects a failed subscribe in health and recovers on reconnect', async () => {
    const rec = makeRecordingBridge({ failSubscribe: true });
    const api = createWailsKimiWebApi(rec.bridge);
    const conn = api.connectEvents(noopHandlers());

    conn.subscribe('s-1', { seq: 0, epoch: 'ep-1' });
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.health()).toEqual({ connected: false, open: false, stale: false });

    rec.setFailSubscribe(false);
    conn.reconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.health()).toEqual({ connected: true, open: true, stale: false });
  });

  // ---------------------------------------------------------------------------
  // Slice 4 — workspace + structured filesystem (P1). Drives the public
  // KimiWebApi methods through the product transport against the mock facade.
  // ---------------------------------------------------------------------------

  it('addWorkspace / updateWorkspace / deleteWorkspace round-trip the wire', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);

    const addPending = api.addWorkspace({ root: '/mock/project', name: 'Project' });
    await vi.advanceTimersByTimeAsync(100);
    const added = await addPending;
    expect(added.root).toBe('/mock/project');
    expect(added.name).toBe('Project');
    expect(added.sessionCount).toBe(0);

    const updatePending = api.updateWorkspace(added.id, { name: 'Renamed' });
    await vi.advanceTimersByTimeAsync(100);
    const updated = await updatePending;
    expect(updated.id).toBe(added.id);
    expect(updated.name).toBe('Renamed');

    const deletePending = api.deleteWorkspace(added.id);
    await vi.advanceTimersByTimeAsync(100);
    await deletePending;

    const listPending = api.listWorkspaces();
    await vi.advanceTimersByTimeAsync(100);
    const list = await listPending;
    expect(list.map((w) => w.id)).not.toContain(added.id);
  });

  it('addWorkspace surfaces a validation error for a non-absolute root', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const pending = api.addWorkspace({ root: 'relative/path' });
    const expectation = expect(pending).rejects.toThrow(/40001/);
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
  });

  it('browseFs maps the folder-picker wire and tolerates failure', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const pending = api.browseFs('/mock');
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.path).toBe('/mock');
    expect(result.entries.every((e) => e.isDir)).toBe(true);
    expect(result.entries[0]?.name).toBe('src');
  });

  it('listDirectory / readFile map the session fs wire to App shapes', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const listPending = api.listDirectory(session.id, { path: '.', includeGitStatus: false });
    await vi.advanceTimersByTimeAsync(100);
    const list = await listPending;
    expect(list.truncated).toBe(false);
    expect(list.items.map((i) => i.name)).toEqual(expect.arrayContaining(['README.md']));
    const srcDir = list.items.find((i) => i.kind === 'directory');
    expect(srcDir?.name).toBe('src');

    const readPending = api.readFile(session.id, { path: 'README.md' });
    await vi.advanceTimersByTimeAsync(100);
    const file = await readPending;
    expect(file.path).toBe('README.md');
    expect(file.encoding).toBe('utf-8');
    expect(file.content).toContain('Mock Session');
    expect(file.isBinary).toBe(false);
  });

  it('readFile rejects with the fs path-not-found code for a missing path', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);
    const pending = api.readFile(session.id, { path: 'nope.txt' });
    const expectation = expect(pending).rejects.toThrow(/40409/);
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
  });

  it('searchFiles / grepFiles / getFileDiff map their wire results', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const searchPending = api.searchFiles(session.id, { query: 'index' });
    await vi.advanceTimersByTimeAsync(100);
    const search = await searchPending;
    expect(search.items[0]?.path).toBe('src/index.ts');
    expect(search.items[0]?.matchPositions.length).toBeGreaterThan(0);

    const grepPending = api.grepFiles(session.id, { pattern: 'console.log' });
    await vi.advanceTimersByTimeAsync(100);
    const grep = await grepPending;
    expect(grep.filesScanned).toBeGreaterThan(0);
    expect(grep.files[0]?.path).toBe('src/index.ts');
    expect(grep.files[0]?.matches[0]?.line).toBe(2);

    const diffPending = api.getFileDiff(session.id, 'README.md');
    await vi.advanceTimersByTimeAsync(100);
    const diff = await diffPending;
    expect(diff.path).toBe('README.md');
    expect(diff.diff).toContain('+++ b/README.md');
  });

  it('openFile / revealFile / openInApp resolve and validate the app id', async () => {
    const bridge = new MockDesktopBridge();
    const api = createWailsKimiWebApi(bridge);
    const session = await createSession(api);

    const openPending = api.openFile(session.id, { path: 'README.md', line: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(openPending).resolves.toEqual({ opened: true });

    const revealPending = api.revealFile(session.id, { path: 'README.md' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(revealPending).resolves.toEqual({ revealed: true });

    const inAppPending = api.openInApp(session.id, 'vscode', 'README.md', 1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(inAppPending).resolves.toBeUndefined();

    const badApp = api.openInApp(session.id, 'emacs', 'README.md');
    const badExpectation = expect(badApp).rejects.toThrow(/40001/);
    await vi.advanceTimersByTimeAsync(100);
    await badExpectation;
  });
});
