import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitialState, reduceAppEvent } from '../daemon/eventReducer';
import type { KimiClientState } from '../daemon/eventReducer';
import { toAppEvent } from '../daemon/mappers';
import type { WireEvent } from '../daemon/wire';
import type { AppEvent, AppSession, KimiEventMeta } from '../types';
import { createWailsKimiWebApi } from './client';
import { isDesktopShellAvailable, isDesktopTransportEnabled } from './index';
import { MockDesktopBridge } from './mock';

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
    const { api, received } = connect(bridge);
    const session = await createSession(api);

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
    expect(() => api.getSession('s-1')).toThrow(/not yet supported/);
    expect(() => api.steerPrompts('s-1', ['p-1'])).toThrow(/not yet supported/);
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
});
