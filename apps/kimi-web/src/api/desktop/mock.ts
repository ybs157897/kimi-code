// apps/kimi-web/src/api/desktop/mock.ts
// Browser dev mock for the desktop bridge. Implements the exact DesktopBridge
// surface and streams a canned turn through the SAME `{sessionId,agentId,event}`
// contract the Wails shell uses, so the demo renders identically under plain
// `pnpm dev` (no Go side) — see docs/plan/desktop-product.md §3 M4 / §6.

import type {
  WireAuthResult,
  WireConfig,
  WireEvent,
  WireExpertTeamDefinition,
  WireExpertTeamSnapshot,
  WireFsBrowseResult,
  WireFsEntry,
  WireFsHomeResult,
  WireMessage,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WireProvider,
  WireProviderRefreshResult,
  WireSession,
  WireSessionSnapshot,
  WireSessionUsage,
  WireTask,
  WireWorkspace,
} from '../daemon/wire';
import type {
  DesktopAgentEvent,
  DesktopBridge,
  DesktopEventPayload,
  DesktopHelloInfo,
  DesktopSessionHandle,
  DesktopSessionListPage,
  DesktopSessionSummary,
  ProductEventPayload,
  ProductStreamCursor,
} from './types';

const MOCK_WORKSPACE_ID = 'mock-workspace';
const MOCK_COMMAND = 'echo "hello from the mock engine"';

/** Whitelisted open-in app ids the mock accepts (mirrors the sidecar list). */
const MOCK_OPEN_IN_APPS = ['finder', 'cursor', 'vscode', 'iterm', 'terminal'];

/**
 * A coded product failure the dispatch wrapper serializes into a kap-server
 * error envelope (frozen contract E), so the desktop client's `call` surfaces
 * the same code/msg it would get from the real sidecar.
 */
class MockEnvelopeError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
  ) {
    super(msg);
    this.name = 'MockEnvelopeError';
  }
}

function mockEnvelopeError(code: number, msg: string): MockEnvelopeError {
  return new MockEnvelopeError(code, msg);
}
const MOCK_COMMAND_OUTPUT = 'hello from the mock engine\n';
const MOCK_REPLY_OPENING = 'Sure — let me run a quick command to demonstrate the stream.\n\n';
const MOCK_REPLY_CLOSING =
  '\n\nThe command printed `hello from the mock engine`. This whole turn was ' +
  'simulated by the browser dev mock — no engine is attached.';

/** Canned expert-team catalog so Modes → 专家团 appears under ?desktop_transport=1. */
const MOCK_EXPERT_TEAMS: WireExpertTeamDefinition[] = [
  {
    plugin_id: 'mock-experts',
    display_name: 'Mock Expert Team',
    description: 'Demo specialists for the desktop transport',
    tags: ['demo'],
    lead_agent_name: 'lead',
    member_agent_names: ['researcher', 'reviewer'],
    members: [
      { agent: 'lead', role: 'lead', display_name: 'Lead' },
      { agent: 'researcher', role: 'member', display_name: 'Researcher' },
      { agent: 'reviewer', role: 'member', display_name: 'Reviewer' },
    ],
    quick_prompts: ['Review this change as a specialist team'],
  },
];

/** Streaming cadence: one assistant.delta every DELTA_INTERVAL_MS per chunk. */
const DELTA_CHUNK_CHARS = 8;
const DELTA_INTERVAL_MS = 24;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnKey(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

interface ActiveTurn {
  turnId: number;
  timers: ReturnType<typeof setTimeout>[];
}

/** Bounded retained-frame count per mock stream (mirrors the sidecar hub). */
const MOCK_JOURNAL_CAPACITY = 1024;

/** Per-session product stream state (epoch/seq/journal + subscription gate). */
interface MockProductStream {
  epoch: string;
  seq: number;
  journal: Array<{ seq: number; event: WireEvent }>;
  subscribed: boolean;
}

interface MockProviderRecord extends WireProvider {
  api_key?: string;
}

export class MockDesktopBridge implements DesktopBridge {
  readonly kind = 'mock' as const;

  private sessions = new Map<string, DesktopSessionSummary>();
  private listeners = new Set<(payload: DesktopEventPayload) => void>();
  private activeTurns = new Map<string, ActiveTurn>();
  private sessionSeq = 0;
  private turnSeq = 0;
  private toolSeq = 0;

  // Phase 1 product layer (frozen contracts E + F): canned kimi-web wire
  // responses + a `WireEvent` stream through the same `{sessionId,agentId,event}`
  // envelope, so the real transcript UI renders without the Go side.
  private productListeners = new Set<(payload: ProductEventPayload) => void>();
  private productSessions = new Map<string, WireSession>();
  private activeProductTurns = new Map<string, ActiveTurn>();
  /**
   * Per-session product stream state mirroring the sidecar `ProductStreamHub`:
   * a stable epoch, a monotonic seq, a bounded journal, and a subscription gate
   * so unsubscribe genuinely stops delivery and a resume cursor replays or
   * resyncs. Keyed by sessionId (the mock scopes to the main agent).
   */
  private productStreams = new Map<string, MockProductStream>();
  private productSessionSeq = 0;
  private productPromptSeq = 0;
  private productMsgSeq = 0;
  private productReqSeq = 0;
  private productDefaultModel = 'mock-model';
  /** Active expert-team snapshot per session (null/absent = standard agent). */
  private productExpertTeamBySession = new Map<string, WireExpertTeamSnapshot>();
  /** Legacy message history per session (for listMessages / snapshot). */
  private productMessagesBySession = new Map<string, WireMessage[]>();
  /** Pending question ids awaiting dismiss/answer. */
  private productPendingQuestions = new Map<string, Set<string>>();
  /** Recently resolved/dismissed question ids (→ 40902). */
  private productResolvedQuestions = new Map<string, Set<string>>();
  /** In-memory tasks per session (for getTask / cancelTask). */
  private productTasksBySession = new Map<string, Map<string, WireTask>>();
  /** Registered workspaces (Slice 4 add/update/delete), seeded with the default. */
  private productWorkspaces = new Map<string, WireWorkspace>([
    [
      MOCK_WORKSPACE_ID,
      { id: MOCK_WORKSPACE_ID, root: '/mock', name: 'mock', session_count: 0 },
    ],
  ]);
  private productWorkspaceSeq = 0;
  /** In-memory file tree per session (Slice 4 structured fs). */
  private productFsBySession = new Map<string, Map<string, string>>();
  private productProviders = new Map<string, MockProviderRecord>([
    [
      'mock',
      {
        id: 'mock',
        type: 'openai',
        base_url: 'https://api.example.test/v1',
        default_model: 'mock-model',
        has_api_key: true,
        status: 'connected',
        models: ['mock-model', 'mock-model-mini'],
        api_key: 'YOUR_API_KEY',
      },
    ],
  ]);
  private productModels: WireModel[] = [
    {
      provider: 'mock',
      model: 'mock-model',
      display_name: 'Mock Model',
      max_context_size: 128000,
      capabilities: ['thinking'],
    },
    {
      provider: 'mock',
      model: 'mock-model-mini',
      display_name: 'Mock Model Mini',
      max_context_size: 32000,
    },
  ];

  constructor() {
    // Seed one session so first load auto-selects it and Modes → 专家团 can
    // load the canned catalog (expert teams are session-scoped on the wire).
    const seeded = this.mockWireSession('mock-session-1', 'Mock session', '/mock');
    seeded.workspace_id = MOCK_WORKSPACE_ID;
    this.productSessions.set(seeded.id, seeded);
    this.productSessionSeq = 1;
  }

  async Hello(): Promise<DesktopHelloInfo> {
    await delay(40);
    return {
      status: 'ok',
      transport: 'mock',
      engine: 'none (browser dev mock)',
      note: 'Simulated health — no sidecar is running.',
    };
  }

  async ListSessions(): Promise<DesktopSessionListPage> {
    await delay(40);
    const items = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return { items };
  }

  async CreateSession(): Promise<DesktopSessionHandle> {
    await delay(60);
    const sessionId = `mock-session-${++this.sessionSeq}`;
    const agentId = 'main';
    const now = Date.now();
    this.sessions.set(sessionId, {
      id: sessionId,
      workspaceId: MOCK_WORKSPACE_ID,
      title: `Mock session ${this.sessionSeq}`,
      createdAt: now,
      updatedAt: now,
      archived: false,
    });
    return { sessionId, agentId };
  }

  async Submit(sessionId: string, agentId: string, text: string): Promise<void> {
    const key = turnKey(sessionId, agentId);
    if (this.activeTurns.has(key)) {
      this.emit(sessionId, agentId, {
        type: 'notice',
        message: 'mock: a turn is already active for this agent',
      });
      return;
    }
    this.touchSession(sessionId, text);

    const turnId = ++this.turnSeq;
    const toolCallId = `mock-tool-${++this.toolSeq}`;
    const startedAt = Date.now();
    const active: ActiveTurn = { turnId, timers: [] };
    this.activeTurns.set(key, active);

    // Scheduled as (delayMs, event) pairs so the stream plays like a real turn:
    // turn.started → assistant deltas → a tool call + result → more deltas →
    // turn.ended.
    const steps: Array<[number, DesktopAgentEvent]> = [];
    let at = 30;
    steps.push([at, { type: 'turn.started', turnId, prompt: text }]);
    for (const delta of chunkText(MOCK_REPLY_OPENING, DELTA_CHUNK_CHARS)) {
      at += DELTA_INTERVAL_MS;
      steps.push([at, { type: 'assistant.delta', turnId, delta }]);
    }
    at += 120;
    steps.push([
      at,
      {
        type: 'tool.call.started',
        turnId,
        toolCallId,
        name: 'Bash',
        args: { command: MOCK_COMMAND },
        description: 'Run a demo command',
      },
    ]);
    at += 200;
    steps.push([
      at,
      { type: 'tool.progress', turnId, toolCallId, update: { kind: 'stdout', text: MOCK_COMMAND_OUTPUT } },
    ]);
    at += 120;
    steps.push([at, { type: 'tool.result', turnId, toolCallId, output: MOCK_COMMAND_OUTPUT, isError: false }]);
    at += 100;
    for (const delta of chunkText(MOCK_REPLY_CLOSING, DELTA_CHUNK_CHARS)) {
      at += DELTA_INTERVAL_MS;
      steps.push([at, { type: 'assistant.delta', turnId, delta }]);
    }

    for (const [delayMs, event] of steps) {
      active.timers.push(setTimeout(() => this.emit(sessionId, agentId, event), delayMs));
    }
    at += 60;
    active.timers.push(
      setTimeout(() => {
        this.activeTurns.delete(key);
        this.emit(sessionId, agentId, {
          type: 'turn.ended',
          turnId,
          reason: 'completed',
          durationMs: Date.now() - startedAt,
        });
      }, at),
    );
  }

  async Cancel(sessionId: string, agentId: string): Promise<void> {
    const key = turnKey(sessionId, agentId);
    const active = this.activeTurns.get(key);
    if (!active) {
      this.emit(sessionId, agentId, { type: 'notice', message: 'mock: no active turn to cancel' });
      return;
    }
    for (const timer of active.timers) clearTimeout(timer);
    this.activeTurns.delete(key);
    this.emit(sessionId, agentId, { type: 'turn.ended', turnId: active.turnId, reason: 'cancelled' });
  }

  onEvent(callback: (payload: DesktopEventPayload) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1 product surface (frozen contracts E + F)
  // ---------------------------------------------------------------------------

  async ProductCall(method: string, argsJSON: string): Promise<string> {
    await delay(40);
    const args = JSON.parse(argsJSON) as unknown[];
    let data: unknown;
    try {
    switch (method) {
      case 'listSessions':
        data = this.productListSessions();
        break;
      case 'createSession':
        data = this.productCreateSession(args[0]);
        break;
      case 'submitPrompt':
        data = this.productSubmitPrompt(args[0] as string, args[1]);
        break;
      case 'abortPrompt':
        data = this.productAbortPrompt(args[0] as string, args[1]);
        break;
      case 'respondApproval':
        data = this.productRespondApproval(args[0] as string, args[1], args[2]);
        break;
      case 'respondQuestion':
        data = this.productRespondQuestion(args[0] as string, args[1], args[2]);
        break;
      // Slice 1 — obvious breakpoints.
      case 'getSession':
        data = this.productGetSession(args[0]);
        break;
      case 'listMessages':
        data = this.productListMessages(args[0], args[1]);
        break;
      case 'dismissQuestion': {
        const dismiss = this.productDismissQuestion(args[0], args[1]);
        return JSON.stringify({
          code: dismiss.code,
          msg: dismiss.msg,
          data: dismiss.data,
          request_id: `mock-req-${++this.productReqSeq}`,
        });
      }
      case 'getTask':
        data = this.productGetTask(args[0], args[1], args[2]);
        break;
      case 'cancelTask': {
        const cancel = this.productCancelTask(args[0], args[1]);
        if (cancel.code !== 0) {
          return JSON.stringify({
            code: cancel.code,
            msg: cancel.msg,
            data: cancel.data,
            request_id: `mock-req-${++this.productReqSeq}`,
          });
        }
        data = cancel.data;
        break;
      }
      // Slice 2 — session control (steer / abort / compact / undo / fork /
      // children / BTW), mirroring the sidecar facade's kap-server wire.
      case 'steerPrompts':
        data = this.productSteerPrompts(args[0], args[1]);
        break;
      case 'abortSession':
        data = this.productAbortSession(args[0]);
        break;
      case 'compactSession':
        data = this.productCompactSession(args[0]);
        break;
      case 'undoSession':
        data = this.productUndoSession(args[0], args[1]);
        break;
      case 'forkSession':
        data = this.productForkSession(args[0], args[1]);
        break;
      case 'createChildSession':
        data = this.productCreateChildSession(args[0], args[1]);
        break;
      case 'listChildSessions':
        data = this.productListChildSessions(args[0]);
        break;
      case 'startBtw':
        data = this.productStartBtw(args[0]);
        break;
      // Slice 2 clean-boot methods (docs §12.3) — canned wire responses so
      // ?desktop_transport=1 boots in a plain browser without the Go side.
      case 'getAuth':
        data = this.productGetAuth();
        break;
      case 'startOAuthLogin':
        data = this.productStartOAuthLogin();
        break;
      case 'pollOAuthLogin':
        data = this.productPollOAuthLogin();
        break;
      case 'cancelOAuthLogin':
        data = this.productCancelOAuthLogin();
        break;
      case 'logout':
        data = this.productLogout();
        break;
      case 'refreshOAuthProviderModels':
        data = this.productRefreshOAuthProviderModels();
        break;
      case 'getHealth':
        data = this.productGetHealth();
        break;
      case 'getMeta':
        data = this.productGetMeta();
        break;
      case 'getConfig':
        data = this.productGetConfig();
        break;
      case 'setConfig':
        data = this.productSetConfig(args[0]);
        break;
      case 'listWorkspaces':
        data = this.productListWorkspaces();
        break;
      case 'addWorkspace':
        data = this.productAddWorkspace(args[0]);
        break;
      case 'updateWorkspace':
        data = this.productUpdateWorkspace(args[0], args[1]);
        break;
      case 'deleteWorkspace':
        data = this.productDeleteWorkspace(args[0]);
        break;
      case 'browseFs':
        data = this.productBrowseFs(args[0]);
        break;
      case 'getFsHome':
        data = this.productGetFsHome();
        break;
      case 'listModels':
        data = this.productListModels();
        break;
      case 'updateSession':
        data = this.productUpdateSession(args[0], args[1]);
        break;
      case 'getSessionStatus':
        data = this.productGetSessionStatus(args[0]);
        break;
      case 'listProviders':
        data = this.productListProviders();
        break;
      case 'getProvider':
        data = this.productGetProvider(args[0]);
        break;
      case 'createProvider':
        data = this.productCreateProvider(args[0]);
        break;
      case 'replaceProvider':
        data = this.productReplaceProvider(args[0], args[1]);
        break;
      case 'deleteProvider':
        data = this.productDeleteProvider(args[0]);
        break;
      case 'refreshProvider':
        data = this.productRefreshProvider(args[0]);
        break;
      case 'refreshAllProviders':
        data = this.productRefreshAllProviders();
        break;
      case 'setDefaultModel':
        data = this.productSetDefaultModel(args[0]);
        break;
      case 'listExpertTeams':
        data = this.productListExpertTeams();
        break;
      case 'getExpertTeam':
        data = this.productGetExpertTeam(args[0]);
        break;
      case 'activateExpertTeam':
        data = this.productActivateExpertTeam(args[0], args[1]);
        break;
      case 'deactivateExpertTeam':
        data = this.productDeactivateExpertTeam(args[0]);
        break;
      case 'getSessionSnapshot':
        data = this.productGetSessionSnapshot(args[0] as string);
        break;
      // Slice 4 — structured session filesystem + native open. The mock keeps a
      // tiny in-memory file tree per session so list/read/search/grep/diff and
      // the open operations exercise the same wire contract as the sidecar.
      case 'listDirectory':
        data = this.productListDirectory(args[0] as string, args[1]);
        break;
      case 'readFile':
        data = this.productReadFile(args[0] as string, args[1]);
        break;
      case 'searchFiles':
        data = this.productSearchFiles(args[0] as string, args[1]);
        break;
      case 'grepFiles':
        data = this.productGrepFiles(args[0] as string, args[1]);
        break;
      case 'getGitStatus':
        data = this.productGetGitStatus();
        break;
      case 'getFileDiff':
        data = this.productGetFileDiff(args[0] as string, args[1]);
        break;
      case 'openFile':
        data = this.productOpenFile(args[0] as string, args[1]);
        break;
      case 'revealFile':
        data = this.productRevealFile(args[0] as string, args[1]);
        break;
      case 'openInApp':
        data = this.productOpenInApp(args[0] as string, args[1], args[2]);
        break;
      default:
        throw new Error(`mock desktop bridge: product method "${method}" is not yet supported`);
    }
    } catch (error) {
      // A coded failure mirrors the kap-server error envelope (frozen contract
      // E) so WailsKimiWebApi.call surfaces the same code/msg as the real
      // sidecar; anything else (e.g. the "not yet supported" guard) propagates.
      if (error instanceof MockEnvelopeError) {
        return JSON.stringify({
          code: error.code,
          msg: error.msg,
          data: null,
          request_id: `mock-req-${++this.productReqSeq}`,
        });
      }
      throw error;
    }
    // The real ProductCall returns the raw kap-server response wire — a
    // WireEnvelope (frozen contract E) — which WailsKimiWebApi.call unwraps
    // (code 0 → data). Mirror that so the mock exercises the same unwrap path.
    return JSON.stringify({
      code: 0,
      msg: 'success',
      data,
      request_id: `mock-req-${++this.productReqSeq}`,
    });
  }

  async ProductSubscribe(
    sessionId: string,
    agentId: string,
    cursor?: ProductStreamCursor,
  ): Promise<void> {
    const stream = this.mockStream(sessionId);
    stream.subscribed = true;
    // Catch-up mirrors the sidecar hub: replay journaled frames after the
    // cursor, or push a resync_required control frame when it cannot be covered.
    if (cursor?.afterSeq === undefined) return;
    const { afterSeq } = cursor;
    if (cursor.epoch !== undefined && cursor.epoch !== stream.epoch) {
      this.deliverResync(sessionId, agentId, 'epoch_changed', stream);
      return;
    }
    if (afterSeq >= stream.seq) return;
    const earliest = stream.journal[0]?.seq;
    if (earliest === undefined || earliest > afterSeq + 1) {
      this.deliverResync(sessionId, agentId, 'buffer_overflow', stream);
      return;
    }
    for (const entry of stream.journal.filter((e) => e.seq > afterSeq)) {
      this.deliverProductFrame(sessionId, agentId, entry.event);
    }
  }

  async ProductUnsubscribe(sessionId: string, _agentId: string): Promise<void> {
    const stream = this.productStreams.get(sessionId);
    if (stream !== undefined) stream.subscribed = false;
  }

  onProductEvent(callback: (payload: ProductEventPayload) => void): () => void {
    this.productListeners.add(callback);
    return () => {
      this.productListeners.delete(callback);
    };
  }

  /** Create-or-get a session's product stream, pinning a stable epoch. */
  private mockStream(sessionId: string): MockProductStream {
    let stream = this.productStreams.get(sessionId);
    if (stream === undefined) {
      stream = { epoch: 'mock-epoch', seq: 0, journal: [], subscribed: false };
      this.productStreams.set(sessionId, stream);
    }
    return stream;
  }

  private emitProduct(sessionId: string, agentId: string, event: WireEvent): void {
    // Stamp the per-session seq, journal it (bounded), then deliver only while
    // subscribed — so unsubscribe stops the stream and a later resume can replay.
    const stream = this.mockStream(sessionId);
    const seq = ++stream.seq;
    const framed = { ...event, seq } as WireEvent;
    stream.journal.push({ seq, event: framed });
    if (stream.journal.length > MOCK_JOURNAL_CAPACITY) {
      stream.journal.splice(0, stream.journal.length - MOCK_JOURNAL_CAPACITY);
    }
    if (!stream.subscribed) return;
    this.deliverProductFrame(sessionId, agentId, framed);
  }

  /** Fan out one already-sequenced frame (live or replayed) to product listeners. */
  private deliverProductFrame(sessionId: string, agentId: string, event: WireEvent): void {
    const payload: ProductEventPayload = { sessionId, agentId, event };
    for (const listener of this.productListeners) listener(payload);
  }

  /** Push a resync_required control frame (not journaled) to product listeners. */
  private deliverResync(
    sessionId: string,
    agentId: string,
    reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed',
    stream: MockProductStream,
  ): void {
    const frame = {
      type: 'resync_required',
      timestamp: new Date().toISOString(),
      payload: { session_id: sessionId, reason, current_seq: stream.seq, epoch: stream.epoch },
    };
    this.deliverProductFrame(sessionId, agentId, frame as unknown as WireEvent);
  }

  /** Build one kimi-web `WireEvent` draft; emitProduct stamps the per-session seq. */
  private wireFrame(type: string, sessionId: string, payload: unknown): WireEvent {
    return {
      type,
      seq: 0,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload,
    } as WireEvent;
  }

  private mockUsage(turnCount: number): WireSessionUsage {
    return {
      input_tokens: 120 * turnCount,
      output_tokens: 80 * turnCount,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 200 * turnCount,
      context_limit: 128000,
      turn_count: turnCount,
    };
  }

  private mockWireSession(id: string, title: string, cwd: string): WireSession {
    const now = new Date().toISOString();
    return {
      id,
      title,
      created_at: now,
      updated_at: now,
      busy: false,
      archived: false,
      metadata: { cwd },
      agent_config: { model: 'mock-model' },
      usage: this.mockUsage(0),
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    };
  }

  private productListSessions(): { items: WireSession[]; has_more: boolean } {
    return { items: [...this.productSessions.values()], has_more: false };
  }

  private productCreateSession(body: unknown): WireSession {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const metadata = record['metadata'] as { cwd?: string } | undefined;
    const id = `mock-session-${++this.productSessionSeq}`;
    const title =
      typeof record['title'] === 'string' && record['title'].length > 0
        ? record['title']
        : `Mock session ${this.productSessionSeq}`;
    const session = this.mockWireSession(id, title, metadata?.cwd ?? '/mock');
    if (typeof record['workspace_id'] === 'string' && record['workspace_id'].length > 0) {
      session.workspace_id = record['workspace_id'];
    } else {
      session.workspace_id = MOCK_WORKSPACE_ID;
    }
    // Honor create-time agent_config (draft model pick from the onboarding
    // composer lands here via WailsKimiWebApi.createSession).
    const agentConfig = isRecord(record['agent_config']) ? record['agent_config'] : undefined;
    if (agentConfig !== undefined) {
      applyMockAgentConfig(session.agent_config, agentConfig);
    }
    this.productSessions.set(id, session);
    return session;
  }

  /** POST /sessions/{id}/profile — persist title / cwd / agent_config fields. */
  private productUpdateSession(sessionIdRaw: unknown, bodyRaw: unknown): WireSession {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    const session = this.productSessions.get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} does not exist`);
    const body = isRecord(bodyRaw) ? bodyRaw : {};
    if (typeof body['title'] === 'string') {
      session.title = body['title'];
    }
    if (isRecord(body['metadata']) && typeof body['metadata']['cwd'] === 'string') {
      session.metadata = { ...session.metadata, cwd: body['metadata']['cwd'] };
    }
    if (isRecord(body['agent_config'])) {
      applyMockAgentConfig(session.agent_config, body['agent_config']);
    }
    session.updated_at = new Date().toISOString();
    this.productSessions.set(sessionId, session);
    return { ...session, agent_config: { ...session.agent_config }, metadata: { ...session.metadata } };
  }

  /** GET /sessions/{id}/status — fold the live model / modes back into the UI. */
  private productGetSessionStatus(sessionIdRaw: unknown): {
    model: string;
    thinking_level: string;
    permission: string;
    plan_mode: boolean;
    swarm_mode: boolean;
    context_tokens: number;
    max_context_tokens: number;
    context_usage: number;
  } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    const session = this.productSessions.get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} does not exist`);
    const usage = session.usage;
    return {
      model: session.agent_config.model,
      thinking_level: session.agent_config.thinking ?? '',
      permission: session.agent_config.permission_mode ?? 'manual',
      plan_mode: session.agent_config.plan_mode === true,
      swarm_mode: session.agent_config.swarm_mode === true,
      context_tokens: usage.context_tokens,
      max_context_tokens: usage.context_limit,
      context_usage:
        usage.context_limit > 0 ? usage.context_tokens / usage.context_limit : 0,
    };
  }

  private productSubmitPrompt(sessionId: string, wire: unknown): {
    prompt_id: string;
    user_message_id: string;
    status: 'running';
  } {
    const submission = wire && typeof wire === 'object' ? (wire as Record<string, unknown>) : {};
    const content = Array.isArray(submission['content']) ? (submission['content'] as Array<Record<string, unknown>>) : [];
    const firstText = content.find((part) => part['type'] === 'text');
    const text = typeof firstText?.['text'] === 'string' ? firstText['text'] : '';
    const promptId = `mock-prompt-${++this.productPromptSeq}`;
    const userMessageId = `mock-usermsg-${this.productPromptSeq}`;
    const userMessage: WireMessage = {
      id: userMessageId,
      session_id: sessionId,
      role: 'user',
      content: text.length > 0 ? [{ type: 'text', text }] : [],
      created_at: new Date().toISOString(),
      prompt_id: promptId,
    };
    this.appendProductMessage(sessionId, userMessage);
    this.startProductTurn(sessionId, 'main', promptId, text);
    return { prompt_id: promptId, user_message_id: userMessageId, status: 'running' };
  }

  private productAbortPrompt(sessionId: string, _promptId: unknown): { aborted: boolean } {
    const key = turnKey(sessionId, 'main');
    const active = this.activeProductTurns.get(key);
    if (active) {
      for (const timer of active.timers) clearTimeout(timer);
      this.activeProductTurns.delete(key);
    }
    this.emitProduct(sessionId, 'main', this.wireFrame('event.session.work_changed', sessionId, {
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
      last_turn_reason: 'cancelled',
    }));
    return { aborted: true };
  }

  private productRespondApproval(sessionId: string, approvalId: unknown, response: unknown): {
    resolved: true;
    resolved_at: string;
  } {
    const record = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
    const resolvedAt = new Date().toISOString();
    this.emitProduct(sessionId, 'main', this.wireFrame('event.approval.resolved', sessionId, {
      approval_id: approvalId,
      decision: record['decision'] ?? 'approved',
      resolved_by: 'user',
      resolved_at: resolvedAt,
    }));
    return { resolved: true, resolved_at: resolvedAt };
  }

  private productRespondQuestion(sessionId: string, questionId: unknown, response: unknown): {
    resolved: true;
    resolved_at: string;
  } {
    const record = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
    const resolvedAt = new Date().toISOString();
    this.emitProduct(sessionId, 'main', this.wireFrame('event.question.answered', sessionId, {
      question_id: questionId,
      answers: record['answers'] ?? {},
      resolved_by: 'user',
      resolved_at: resolvedAt,
    }));
    return { resolved: true, resolved_at: resolvedAt };
  }

  // ---------------------------------------------------------------------------
  // Slice 2 — session control. Canned kap-server wire shapes; state changes
  // stay observable through the session map (fork/child) and message store.
  // ---------------------------------------------------------------------------

  /** POST /sessions/{id}/prompts:steer — echo the steered prompt ids. */
  private productSteerPrompts(
    sessionIdRaw: unknown,
    bodyRaw: unknown,
  ): { steered: true; prompt_ids: string[] } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const promptIds = isRecord(bodyRaw) ? bodyRaw['prompt_ids'] : undefined;
    if (!Array.isArray(promptIds) || promptIds.some((id) => typeof id !== 'string')) {
      throw new Error('prompt_ids must be a string array');
    }
    return { steered: true, prompt_ids: [...(promptIds as string[])] };
  }

  /** POST /sessions/{id}:abort — cancel the active turn; idempotent success. */
  private productAbortSession(sessionIdRaw: unknown): { aborted: true } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    this.productAbortPrompt(sessionId, undefined);
    return { aborted: true };
  }

  /** POST /sessions/{id}:compact — accepted; completion arrives via events. */
  private productCompactSession(sessionIdRaw: unknown): Record<string, never> {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    return {};
  }

  /** POST /sessions/{id}:undo — drop the last `count` prompts' messages. */
  private productUndoSession(
    sessionIdRaw: unknown,
    bodyRaw: unknown,
  ): { messages: { items: WireMessage[]; has_more: boolean }; status: 'idle' } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const body = isRecord(bodyRaw) ? bodyRaw : {};
    const count = typeof body['count'] === 'number' && body['count'] > 0 ? body['count'] : 1;
    const messages = this.productMessagesBySession.get(sessionId) ?? [];
    const promptIds: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const promptId = messages[i]?.prompt_id;
      if (typeof promptId === 'string' && !promptIds.includes(promptId)) {
        promptIds.push(promptId);
        if (promptIds.length === count) break;
      }
    }
    const cut = new Set(promptIds);
    const remaining = messages.filter(
      (message) => message.prompt_id === undefined || !cut.has(message.prompt_id),
    );
    this.productMessagesBySession.set(sessionId, remaining);
    return { messages: { items: remaining, has_more: false }, status: 'idle' };
  }

  /** POST /sessions/{id}:fork — new session inheriting title/cwd/history. */
  private productForkSession(sessionIdRaw: unknown, bodyRaw: unknown): WireSession {
    const source = this.productGetSession(sessionIdRaw);
    const body = isRecord(bodyRaw) ? bodyRaw : {};
    const title = typeof body['title'] === 'string' ? body['title'] : source.title;
    const id = `mock-session-${++this.productSessionSeq}`;
    const forked = this.mockWireSession(id, title, source.metadata.cwd);
    forked.workspace_id = source.workspace_id;
    forked.agent_config = { ...source.agent_config };
    this.productSessions.set(id, forked);
    this.productMessagesBySession.set(id, [
      ...(this.productMessagesBySession.get(source.id) ?? []),
    ]);
    return forked;
  }

  /** POST /sessions/{id}/children — fork tagged with parent_session_id. */
  private productCreateChildSession(sessionIdRaw: unknown, bodyRaw: unknown): WireSession {
    const child = this.productForkSession(sessionIdRaw, bodyRaw);
    child.metadata = {
      ...child.metadata,
      parent_session_id: requireMockString(sessionIdRaw, 'session id'),
    };
    return child;
  }

  /** GET /sessions/{id}/children — sessions whose parent marker matches. */
  private productListChildSessions(sessionIdRaw: unknown): {
    items: WireSession[];
    has_more: boolean;
  } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const items = [...this.productSessions.values()].filter(
      (session) => session.metadata['parent_session_id'] === sessionId,
    );
    return { items, has_more: false };
  }

  /** POST /sessions/{id}:btw — hand back a stable side-channel agent id. */
  private productStartBtw(sessionIdRaw: unknown): { agent_id: string } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    return { agent_id: `mock-btw-${sessionId}` };
  }

  // ---------------------------------------------------------------------------
  // Slice 2 clean-boot methods (docs §12.3) — canned kap-server wire shapes.
  // ---------------------------------------------------------------------------

  private productGetAuth(): WireAuthResult {
    return {
      ready: true,
      providers_count: this.productProviders.size,
      default_model: this.productDefaultModel,
      managed_provider: { status: 'connected' },
    };
  }

  private productStartOAuthLogin(): WireOAuthLoginStartResult {
    return {
      flow_id: 'mock-oauth-flow',
      provider: 'kimi',
      status: 'authenticated',
    };
  }

  private productPollOAuthLogin(): WireOAuthLoginPollResult {
    return {
      flow_id: 'mock-oauth-flow',
      status: 'authenticated',
      resolved_at: new Date().toISOString(),
    };
  }

  private productCancelOAuthLogin(): WireOAuthCancelResult {
    return { cancelled: false, status: 'authenticated' };
  }

  private productLogout(): { logged_out: true } {
    return { logged_out: true };
  }

  private productRefreshOAuthProviderModels(): WireProviderRefreshResult {
    return { changed: [], unchanged: ['kimi'], failed: [] };
  }

  /** kap-server healthz returns the static `{ ok: true }` shape. */
  private productGetHealth(): { ok: true } {
    return { ok: true };
  }

  private productGetMeta(): {
    server_version: string;
    server_id: string;
    started_at: string;
    capabilities: Record<string, boolean>;
    open_in_apps: string[];
    dangerous_bypass_auth: boolean;
    backend: 'v2';
  } {
    return {
      server_version: '0.0.0-mock',
      server_id: 'mock-server',
      started_at: new Date().toISOString(),
      capabilities: {},
      open_in_apps: [],
      dangerous_bypass_auth: false,
      backend: 'v2',
    };
  }

  private productGetConfig(): WireConfig {
    const providers: WireConfig['providers'] = {};
    for (const provider of this.productProviders.values()) {
      providers[provider.id] = {
        type: provider.type,
        base_url: provider.base_url,
        default_model: provider.default_model,
        has_api_key: provider.has_api_key,
      };
    }
    return {
      providers,
      default_provider: 'mock',
      default_model: this.productDefaultModel,
    };
  }

  private productSetConfig(raw: unknown): WireConfig {
    if (isRecord(raw) && typeof raw['default_model'] === 'string') {
      this.productDefaultModel = raw['default_model'];
    }
    return this.productGetConfig();
  }

  private productListWorkspaces(): { items: WireWorkspace[]; has_more: boolean } {
    const items = [...this.productWorkspaces.values()].map((ws) =>
      ws.id === MOCK_WORKSPACE_ID ? { ...ws, session_count: this.productSessions.size } : ws,
    );
    return { items, has_more: false };
  }

  private productGetFsHome(): WireFsHomeResult {
    return { home: '/mock', recent_roots: ['/mock'] };
  }

  // Slice 4 — workspace mutations. The mock keeps a small registry seeded with
  // the default workspace so add/update/delete round-trip the wire shape.
  private productAddWorkspace(inputRaw: unknown): WireWorkspace {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const root = typeof input['root'] === 'string' ? input['root'] : '';
    if (root === '' || !root.startsWith('/')) {
      throw mockEnvelopeError(40001, 'root must be an absolute path');
    }
    const name = typeof input['name'] === 'string' && input['name'].length > 0 ? input['name'] : root.split('/').pop() ?? root;
    const ws: WireWorkspace = {
      id: `mock-ws-${++this.productWorkspaceSeq}`,
      root,
      name,
      session_count: 0,
    };
    this.productWorkspaces.set(ws.id, ws);
    return ws;
  }

  private productUpdateWorkspace(idRaw: unknown, inputRaw: unknown): WireWorkspace {
    const id = typeof idRaw === 'string' ? idRaw : '';
    const ws = this.productWorkspaces.get(id);
    if (ws === undefined) {
      throw mockEnvelopeError(40410, `workspace ${id} does not exist`);
    }
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    if (typeof input['name'] === 'string' && input['name'].length > 0) ws.name = input['name'];
    return ws;
  }

  private productDeleteWorkspace(idRaw: unknown): { deleted: true } {
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!this.productWorkspaces.has(id)) {
      throw mockEnvelopeError(40410, `workspace ${id} does not exist`);
    }
    this.productWorkspaces.delete(id);
    return { deleted: true };
  }

  private productBrowseFs(pathRaw: unknown): WireFsBrowseResult {
    const path = typeof pathRaw === 'string' && pathRaw.length > 0 ? pathRaw : '/mock';
    return {
      path,
      parent: path === '/' ? null : path.replace(/\/[^/]+\/?$/, '') || '/',
      entries: [
        { name: 'src', path: `${path}/src`, is_dir: true },
        { name: 'docs', path: `${path}/docs`, is_dir: true },
      ],
    };
  }

  // Slice 4 — structured session filesystem. A tiny canned tree per session
  // (seeded lazily) backs list/read/search/grep/diff so the desktop client and
  // its tests exercise the same wire shapes the sidecar ISessionFsService
  // returns; paths are matched relative to the session root.
  private productFsTree(sessionId: string): Map<string, string> {
    let tree = this.productFsBySession.get(sessionId);
    if (tree === undefined) {
      tree = new Map([
        ['README.md', '# Mock Session\n\nhello world\n'],
        ['src/index.ts', 'export function main(): void {\n  console.log("hi");\n}\n'],
      ]);
      this.productFsBySession.set(sessionId, tree);
    }
    return tree;
  }

  private productListDirectory(
    sessionId: string,
    inputRaw: unknown,
  ): { items: WireFsEntry[]; children_by_path?: Record<string, WireFsEntry[]>; truncated: boolean } {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const reqPath = typeof input['path'] === 'string' && input['path'] !== '' ? input['path'] : '.';
    const tree = this.productFsTree(sessionId);
    const now = new Date().toISOString();
    const prefix = reqPath === '.' ? '' : `${reqPath.replace(/\/$/, '')}/`;
    const items: WireFsEntry[] = [];
    const seenDirs = new Set<string>();
    for (const [relPath, content] of tree) {
      if (!relPath.startsWith(prefix)) continue;
      const rest = relPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        items.push({
          path: relPath,
          name: rest,
          kind: 'file',
          size: content.length,
          modified_at: now,
          mime: 'text/plain',
          is_binary: false,
        });
      } else {
        const dirName = rest.slice(0, slash);
        const dirPath = `${prefix}${dirName}`;
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          items.push({ path: dirPath, name: dirName, kind: 'directory', modified_at: now });
        }
      }
    }
    return { items, truncated: false };
  }

  private productReadFile(
    sessionId: string,
    inputRaw: unknown,
  ): {
    path: string;
    content: string;
    encoding: 'utf-8';
    size: number;
    truncated: boolean;
    etag: string;
    mime: string;
    language_id: string;
    line_count: number;
    is_binary: boolean;
  } {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    const tree = this.productFsTree(sessionId);
    const content = tree.get(path);
    if (content === undefined) {
      throw mockEnvelopeError(40409, `path not found: ${path}`);
    }
    return {
      path,
      content,
      encoding: 'utf-8',
      size: content.length,
      truncated: false,
      etag: `mock-etag-${content.length}`,
      mime: 'text/plain',
      language_id: 'typescript',
      line_count: content.split('\n').length,
      is_binary: false,
    };
  }

  private productSearchFiles(
    sessionId: string,
    inputRaw: unknown,
  ): {
    items: Array<{ path: string; name: string; kind: 'file'; score: number; match_positions: number[] }>;
    truncated: boolean;
  } {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const query = typeof input['query'] === 'string' ? input['query'].toLowerCase() : '';
    const tree = this.productFsTree(sessionId);
    const items: Array<{ path: string; name: string; kind: 'file'; score: number; match_positions: number[] }> = [];
    for (const relPath of tree.keys()) {
      const name = relPath.split('/').pop() ?? relPath;
      const idx = name.toLowerCase().indexOf(query);
      if (query !== '' && idx >= 0) {
        items.push({ path: relPath, name, kind: 'file', score: 1, match_positions: [idx] });
      }
    }
    return { items, truncated: false };
  }

  private productGrepFiles(
    sessionId: string,
    inputRaw: unknown,
  ): {
    files: Array<{
      path: string;
      matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }>;
    }>;
    files_scanned: number;
    truncated: boolean;
    elapsed_ms: number;
  } {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : '';
    const tree = this.productFsTree(sessionId);
    const files: Array<{
      path: string;
      matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }>;
    }> = [];
    let scanned = 0;
    for (const [relPath, content] of tree) {
      scanned++;
      const lines = content.split('\n');
      const matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }> = [];
      lines.forEach((text, i) => {
        const col = text.indexOf(pattern);
        if (pattern !== '' && col >= 0) {
          matches.push({ line: i + 1, col: col + 1, text, before: [], after: [] });
        }
      });
      if (matches.length > 0) files.push({ path: relPath, matches });
    }
    return { files, files_scanned: scanned, truncated: false, elapsed_ms: 1 };
  }

  private productGetGitStatus(): {
    branch: string;
    ahead: number;
    behind: number;
    entries: Record<string, string>;
    additions: number;
    deletions: number;
    pullRequest: null;
  } {
    return { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
  }

  private productGetFileDiff(sessionId: string, pathRaw: unknown): { path: string; diff: string } {
    const path = typeof pathRaw === 'string' ? pathRaw : '';
    const tree = this.productFsTree(sessionId);
    if (!tree.has(path)) {
      throw mockEnvelopeError(40409, `path not found: ${path}`);
    }
    return { path, diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` };
  }

  private productOpenFile(sessionId: string, inputRaw: unknown): { opened: true } {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    if (!this.productFsTree(sessionId).has(path)) {
      throw mockEnvelopeError(40409, `path not found: ${path}`);
    }
    return { opened: true };
  }

  private productRevealFile(sessionId: string, inputRaw: unknown): { revealed: true } {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    if (!this.productFsTree(sessionId).has(path)) {
      throw mockEnvelopeError(40409, `path not found: ${path}`);
    }
    return { revealed: true };
  }

  private productOpenInApp(sessionId: string, appIdRaw: unknown, pathRaw: unknown): { opened: true } {
    const appId = typeof appIdRaw === 'string' ? appIdRaw : '';
    const path = typeof pathRaw === 'string' ? pathRaw : '';
    if (!MOCK_OPEN_IN_APPS.includes(appId)) {
      throw mockEnvelopeError(40001, `unsupported app_id: ${appId}`);
    }
    if (!this.productFsTree(sessionId).has(path)) {
      throw mockEnvelopeError(40409, `path not found: ${path}`);
    }
    return { opened: true };
  }

  private productListModels(): { items: WireModel[] } {
    return { items: this.productModels.map((model) => ({ ...model })) };
  }

  private productListProviders(): { items: WireProvider[] } {
    return {
      items: [...this.productProviders.values()].map(({ api_key: _apiKey, ...provider }) => ({
        ...provider,
      })),
    };
  }

  private productGetProvider(idRaw: unknown): MockProviderRecord {
    const id = requireMockString(idRaw, 'provider id');
    const provider = this.productProviders.get(id);
    if (provider === undefined) throw new Error(`provider ${id} does not exist`);
    return { ...provider, models: [...(provider.models ?? [])] };
  }

  private productCreateProvider(raw: unknown): WireProvider {
    const input = mockProviderInput(raw);
    if (this.productProviders.has(input.id)) {
      throw new Error(`provider ${input.id} already exists`);
    }
    const provider = this.storeMockProvider(input);
    if (!this.productDefaultModel && input.models[0] !== undefined) {
      this.productDefaultModel = `${input.id}/${input.models[0].model}`;
    }
    const { api_key: _apiKey, ...wire } = provider;
    return wire;
  }

  private productReplaceProvider(idRaw: unknown, raw: unknown): { provider: WireProvider } {
    const existingId = requireMockString(idRaw, 'provider id');
    const existing = this.productProviders.get(existingId);
    if (existing === undefined) throw new Error(`provider ${existingId} does not exist`);
    const input = mockProviderInput(raw, existingId);
    if (input.id !== existingId && this.productProviders.has(input.id)) {
      throw new Error(`provider ${input.id} already exists`);
    }
    this.productProviders.delete(existingId);
    this.productModels = this.productModels.filter((model) => model.provider !== existingId);
    const provider = this.storeMockProvider({
      ...input,
      apiKey: input.apiKey ?? existing.api_key,
    });
    if (input.id !== existingId && this.productDefaultModel.startsWith(`${existingId}/`)) {
      this.productDefaultModel = `${input.id}/${this.productDefaultModel.slice(existingId.length + 1)}`;
    }
    const { api_key: _apiKey, ...wire } = provider;
    return { provider: wire };
  }

  private productDeleteProvider(idRaw: unknown): { deleted: true } {
    const id = requireMockString(idRaw, 'provider id');
    if (!this.productProviders.delete(id)) throw new Error(`provider ${id} does not exist`);
    this.productModels = this.productModels.filter((model) => model.provider !== id);
    return { deleted: true };
  }

  private productRefreshProvider(idRaw: unknown): WireProviderRefreshResult {
    const id = requireMockString(idRaw, 'provider id');
    if (!this.productProviders.has(id)) throw new Error(`provider ${id} does not exist`);
    return { changed: [], unchanged: [id], failed: [] };
  }

  private productRefreshAllProviders(): WireProviderRefreshResult {
    return {
      changed: [],
      unchanged: [...this.productProviders.keys()],
      failed: [],
    };
  }

  private productSetDefaultModel(idRaw: unknown): { default_model: string } {
    const id = requireMockString(idRaw, 'model id');
    if (!this.productModels.some((model) => model.model === id)) {
      throw new Error(`model ${id} does not exist`);
    }
    this.productDefaultModel = id;
    return { default_model: id };
  }

  /** GET /sessions/{id}/expert-teams — canned catalog for desktop_transport. */
  private productListExpertTeams(): { experts: WireExpertTeamDefinition[] } {
    return { experts: MOCK_EXPERT_TEAMS.map((team) => ({ ...team, members: [...team.members] })) };
  }

  /** GET /sessions/{id}/expert-team — active binding, or null. */
  private productGetExpertTeam(sessionIdRaw: unknown): {
    expert_team: WireExpertTeamSnapshot | null;
  } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    return { expert_team: this.productExpertTeamBySession.get(sessionId) ?? null };
  }

  /** POST /sessions/{id}/expert-team/activate — binds a catalog team; exits swarm. */
  private productActivateExpertTeam(
    sessionIdRaw: unknown,
    bodyRaw: unknown,
  ): { expert_team: WireExpertTeamSnapshot } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const pluginId = requireMockString(
      isRecord(bodyRaw) ? bodyRaw['plugin_id'] : undefined,
      'plugin id',
    );
    const team = MOCK_EXPERT_TEAMS.find((candidate) => candidate.plugin_id === pluginId);
    if (team === undefined) throw new Error(`expert team ${pluginId} was not found`);
    const snapshot: WireExpertTeamSnapshot = {
      binding: {
        plugin_id: team.plugin_id,
        plugin_version: team.plugin_version,
        display_name: team.display_name,
        lead_agent_name: team.lead_agent_name,
        lead_profile_name: `expert:${team.plugin_id}:${team.lead_agent_name}`,
        member_agent_names: [...team.member_agent_names],
        previous_profile_name: 'agent',
        activated_at: new Date().toISOString(),
      },
    };
    this.productExpertTeamBySession.set(sessionId, snapshot);
    // Expert-team mode owns the main agent — the daemon force-exits swarm.
    const session = this.productSessions.get(sessionId);
    if (session !== undefined) {
      session.agent_config.swarm_mode = false;
      session.updated_at = new Date().toISOString();
    }
    return { expert_team: snapshot };
  }

  /** POST /sessions/{id}/expert-team/deactivate — restore the standard agent. */
  private productDeactivateExpertTeam(sessionIdRaw: unknown): { deactivated: true } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    this.productExpertTeamBySession.delete(sessionId);
    return { deactivated: true };
  }

  /** GET /sessions/{id} — return the wire session or throw. */
  private productGetSession(sessionIdRaw: unknown): WireSession {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    const session = this.productSessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    return session;
  }

  /** GET /sessions/{id}/messages — cursor page over stored messages. */
  private productListMessages(
    sessionIdRaw: unknown,
    queryRaw: unknown,
  ): { items: WireMessage[]; has_more: boolean } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const query = isRecord(queryRaw) ? queryRaw : {};
    if (typeof query['before_id'] === 'string' && typeof query['after_id'] === 'string') {
      throw new Error('before_id and after_id are mutually exclusive');
    }
    let items = [...(this.productMessagesBySession.get(sessionId) ?? [])];
    const role = query['role'];
    if (typeof role === 'string') {
      items = items.filter((m) => m.role === role);
    }
    const pageSize =
      typeof query['page_size'] === 'number' && query['page_size'] > 0
        ? Math.min(query['page_size'], 100)
        : 50;
    const beforeId = typeof query['before_id'] === 'string' ? query['before_id'] : undefined;
    const afterId = typeof query['after_id'] === 'string' ? query['after_id'] : undefined;
    if (beforeId !== undefined) {
      const idx = items.findIndex((m) => m.id === beforeId);
      items = idx > 0 ? items.slice(0, idx) : [];
    } else if (afterId !== undefined) {
      const idx = items.findIndex((m) => m.id === afterId);
      items = idx >= 0 ? items.slice(idx + 1) : items;
    }
    const hasMore = items.length > pageSize;
    return { items: items.slice(-pageSize), has_more: hasMore };
  }

  /**
   * POST /sessions/{id}/questions/{qid}:dismiss — success envelope is 40909,
   * matching kap-server / the daemon allowCodes path.
   */
  private productDismissQuestion(
    sessionIdRaw: unknown,
    questionIdRaw: unknown,
  ): {
    code: number;
    msg: string;
    data: { dismissed: true; dismissed_at: string } | { resolved: false };
  } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    const questionId = requireMockString(questionIdRaw, 'question id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const pending = this.productPendingQuestions.get(sessionId);
    if (pending?.has(questionId) !== true) {
      if (this.productResolvedQuestions.get(sessionId)?.has(questionId) === true) {
        return {
          code: 40902,
          msg: `question ${questionId} already resolved`,
          data: { resolved: false },
        };
      }
      throw new Error(`question ${questionId} not found`);
    }
    pending.delete(questionId);
    const resolved = this.productResolvedQuestions.get(sessionId) ?? new Set<string>();
    resolved.add(questionId);
    this.productResolvedQuestions.set(sessionId, resolved);
    return {
      code: 40909,
      msg: `question ${questionId} dismissed`,
      data: { dismissed: true, dismissed_at: new Date().toISOString() },
    };
  }

  /** GET /sessions/{id}/tasks/{tid}. */
  private productGetTask(
    sessionIdRaw: unknown,
    taskIdRaw: unknown,
    queryRaw: unknown,
  ): WireTask {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    const taskId = requireMockString(taskIdRaw, 'task id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const task = this.productTasksBySession.get(sessionId)?.get(taskId);
    if (task === undefined) {
      throw new Error(`task ${taskId} does not exist in session ${sessionId}`);
    }
    const query = isRecord(queryRaw) ? queryRaw : {};
    if (query['with_output'] === true) {
      const preview = task.output_preview ?? '';
      return {
        ...task,
        output_preview: preview,
        output_bytes: preview.length > 0 ? new TextEncoder().encode(preview).byteLength : task.output_bytes,
      };
    }
    return { ...task };
  }

  /** POST /sessions/{id}/tasks/{tid}:cancel — 40904 when already terminal. */
  private productCancelTask(
    sessionIdRaw: unknown,
    taskIdRaw: unknown,
  ): {
    code: number;
    msg: string;
    data: { cancelled: true } | { cancelled: false };
  } {
    const sessionId = requireMockString(sessionIdRaw, 'session id');
    const taskId = requireMockString(taskIdRaw, 'task id');
    if (!this.productSessions.has(sessionId)) {
      throw new Error(`session ${sessionId} does not exist`);
    }
    const tasks = this.productTasksBySession.get(sessionId);
    const task = tasks?.get(taskId);
    if (task === undefined) {
      throw new Error(`task ${taskId} does not exist in session ${sessionId}`);
    }
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return {
        code: 40904,
        msg: `task ${taskId} already finished (status: ${task.status})`,
        data: { cancelled: false },
      };
    }
    const updated: WireTask = {
      ...task,
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    };
    tasks?.set(taskId, updated);
    return { code: 0, msg: 'success', data: { cancelled: true } };
  }

  /** Test helper: seed a pending question for dismissQuestion coverage. */
  seedPendingQuestion(sessionId: string, questionId: string): void {
    const pending = this.productPendingQuestions.get(sessionId) ?? new Set<string>();
    pending.add(questionId);
    this.productPendingQuestions.set(sessionId, pending);
  }

  /** Test helper: seed a task for getTask / cancelTask coverage. */
  seedTask(sessionId: string, task: WireTask): void {
    const tasks = this.productTasksBySession.get(sessionId) ?? new Map<string, WireTask>();
    tasks.set(task.id, task);
    this.productTasksBySession.set(sessionId, tasks);
  }

  private appendProductMessage(sessionId: string, message: WireMessage): void {
    const list = this.productMessagesBySession.get(sessionId) ?? [];
    list.push(message);
    this.productMessagesBySession.set(sessionId, list);
  }

  private storeMockProvider(input: MockProviderInput): MockProviderRecord {
    const modelIds = input.models.map((model) => `${input.id}/${model.model}`);
    const provider: MockProviderRecord = {
      id: input.id,
      type: input.type,
      base_url: input.baseUrl,
      default_model:
        input.defaultModel === undefined ? modelIds[0] : `${input.id}/${input.defaultModel}`,
      has_api_key: Boolean(input.apiKey),
      status: input.apiKey ? 'connected' : 'unconfigured',
      models: modelIds,
      api_key: input.apiKey,
    };
    this.productProviders.set(input.id, provider);
    this.productModels.push(
      ...input.models.map((model) => ({
        provider: input.id,
        model: `${input.id}/${model.model}`,
        display_name: model.displayName,
        max_context_size: model.maxContextSize,
      })),
    );
    return provider;
  }

  private productGetSessionSnapshot(sessionId: string): WireSessionSnapshot {
    const session =
      this.productSessions.get(sessionId) ??
      this.mockWireSession(sessionId, `Mock session ${sessionId}`, '/mock');
    const messages = this.productMessagesBySession.get(sessionId) ?? [];
    // Share the watermark with the product stream so the subscribe() that
    // follows resumes at exactly this (epoch, seq) — mirrors the sidecar facade.
    const stream = this.mockStream(sessionId);
    return {
      as_of_seq: stream.seq,
      epoch: stream.epoch,
      session,
      messages: { items: messages, has_more: false },
      in_flight_turn: null,
      subagents: [],
      pending_approvals: [],
      pending_questions: [],
    };
  }

  /**
   * Stream a canned turn as kimi-web `WireEvent`s through the product envelope:
   * work_changed(busy) → assistant message.created → assistant.delta chunks →
   * message.updated (adds the tool_use card) → tool.output → tool-result
   * message.created → message.updated(completed) → usage_updated →
   * work_changed(idle). Mirrors the kap-server WireEvent protocol that
   * `toAppEvent` consumes, so the real eventReducer drives the transcript UI.
   */
  private startProductTurn(sessionId: string, agentId: string, promptId: string, promptText: string): void {
    const key = turnKey(sessionId, agentId);
    if (this.activeProductTurns.has(key)) return;
    const active: ActiveTurn = { turnId: ++this.turnSeq, timers: [] };
    this.activeProductTurns.set(key, active);

    const assistantMsgId = `mock-asstmsg-${++this.productMsgSeq}`;
    const toolCallId = `mock-tool-${++this.toolSeq}`;
    const toolResultMsgId = `mock-toolmsg-${++this.productMsgSeq}`;
    const fullOpening = MOCK_REPLY_OPENING + (promptText.length > 0 ? `(You said: ${promptText})\n\n` : '');

    const assistantMessage: WireMessage = {
      id: assistantMsgId,
      session_id: sessionId,
      role: 'assistant',
      content: [],
      created_at: new Date().toISOString(),
      prompt_id: promptId,
    };
    const textPart = { type: 'text' as const, text: fullOpening };
    const toolUsePart = {
      type: 'tool_use' as const,
      tool_call_id: toolCallId,
      tool_name: 'Bash',
      input: { command: MOCK_COMMAND },
    };
    const toolResultMessage: WireMessage = {
      id: toolResultMsgId,
      session_id: sessionId,
      role: 'tool',
      content: [{ type: 'tool_result' as const, tool_call_id: toolCallId, output: MOCK_COMMAND_OUTPUT, is_error: false }],
      created_at: new Date().toISOString(),
      prompt_id: promptId,
    };

    const frames: Array<[number, WireEvent]> = [];
    let at = 30;
    frames.push([at, this.wireFrame('event.session.work_changed', sessionId, {
      busy: true,
      main_turn_active: true,
      pending_interaction: 'none',
    })]);
    frames.push([at, this.wireFrame('event.message.created', sessionId, { message: assistantMessage })]);
    for (const chunk of chunkText(fullOpening, DELTA_CHUNK_CHARS)) {
      at += DELTA_INTERVAL_MS;
      frames.push([at, this.wireFrame('event.assistant.delta', sessionId, {
        message_id: assistantMsgId,
        content_index: 0,
        delta: { text: chunk },
      })]);
    }
    at += 120;
    frames.push([at, this.wireFrame('event.message.updated', sessionId, {
      message_id: assistantMsgId,
      content: [textPart, toolUsePart],
      status: 'pending',
    })]);
    at += 200;
    frames.push([at, this.wireFrame('event.tool.output', sessionId, {
      tool_call_id: toolCallId,
      chunk: MOCK_COMMAND_OUTPUT,
      stream: 'stdout',
    })]);
    at += 120;
    frames.push([at, this.wireFrame('event.message.created', sessionId, { message: toolResultMessage })]);
    // NOTE: no final content-replacing `message.updated` here — the reducer
    // replaces content wholesale, which would wipe the tool `outputLines` the
    // `event.tool.output` frame just accumulated. The turn ends on work_changed.
    at += 40;
    frames.push([at, this.wireFrame('event.session.usage_updated', sessionId, {
      usage: this.mockUsage(1),
      delta: { input_tokens: 120, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 },
    })]);
    at += 40;
    frames.push([at, this.wireFrame('event.session.work_changed', sessionId, {
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
      last_turn_reason: 'completed',
    })]);

    for (const [delayMs, event] of frames) {
      active.timers.push(setTimeout(() => this.emitProduct(sessionId, agentId, event), delayMs));
    }
    active.timers.push(
      setTimeout(() => this.activeProductTurns.delete(key), at + 10),
    );
  }

  private emit(sessionId: string, agentId: string, event: DesktopAgentEvent): void {
    const payload: DesktopEventPayload = { sessionId, agentId, event };
    for (const listener of this.listeners) listener(payload);
  }

  /** Keep ListSessions realistic: record the prompt on the touched session. */
  private touchSession(sessionId: string, text: string): void {
    const existing = this.sessions.get(sessionId);
    const now = Date.now();
    if (existing) {
      this.sessions.set(sessionId, { ...existing, lastPrompt: text, updatedAt: now });
      return;
    }
    // Submit without a prior CreateSession — accept it leniently.
    this.sessions.set(sessionId, {
      id: sessionId,
      workspaceId: MOCK_WORKSPACE_ID,
      title: text.slice(0, 40) || sessionId,
      lastPrompt: text,
      createdAt: now,
      updatedAt: now,
      archived: false,
    });
  }
}

interface MockProviderModelInput {
  model: string;
  displayName?: string;
  maxContextSize: number;
}

interface MockProviderInput {
  id: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models: MockProviderModelInput[];
}

function mockProviderInput(raw: unknown, fallbackId?: string): MockProviderInput {
  if (!isRecord(raw)) throw new Error('provider input must be an object');
  const id = requireMockString(raw['new_id'] ?? raw['id'] ?? fallbackId, 'provider id');
  const type = requireMockString(raw['type'], 'provider type');
  if (!Array.isArray(raw['models']) || raw['models'].length === 0) {
    throw new Error('provider must define at least one model');
  }
  return {
    id,
    type,
    apiKey:
      Object.prototype.hasOwnProperty.call(raw, 'api_key')
        ? optionalMockString(raw['api_key'])
        : undefined,
    baseUrl: optionalMockString(raw['base_url']),
    defaultModel: optionalMockString(raw['default_model']),
    models: raw['models'].map((value) => {
      if (!isRecord(value)) throw new Error('provider model must be an object');
      const maxContextSize = value['max_context_size'];
      if (typeof maxContextSize !== 'number' || !Number.isFinite(maxContextSize)) {
        throw new Error('provider model context size must be a number');
      }
      return {
        model: requireMockString(value['model'], 'model name'),
        displayName: optionalMockString(value['display_name']),
        maxContextSize,
      };
    }),
  };
}

function requireMockString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function optionalMockString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mutate a session's agent_config from a POST /profile (or create) body. */
function applyMockAgentConfig(
  target: WireSession['agent_config'],
  patch: Record<string, unknown>,
): void {
  if (typeof patch['model'] === 'string') target.model = patch['model'];
  if (typeof patch['thinking'] === 'string') target.thinking = patch['thinking'];
  if (typeof patch['permission_mode'] === 'string') {
    target.permission_mode = patch['permission_mode'];
  }
  if (typeof patch['plan_mode'] === 'boolean') target.plan_mode = patch['plan_mode'];
  if (typeof patch['swarm_mode'] === 'boolean') target.swarm_mode = patch['swarm_mode'];
  if (typeof patch['goal_objective'] === 'string') {
    target.goal_objective = patch['goal_objective'];
  }
  if (
    patch['goal_control'] === 'pause' ||
    patch['goal_control'] === 'resume' ||
    patch['goal_control'] === 'cancel'
  ) {
    target.goal_control = patch['goal_control'];
  }
}
