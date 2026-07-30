// apps/kimi-web/src/api/desktop/mock.ts
// Browser dev mock for the desktop bridge. Implements the exact DesktopBridge
// surface and streams a canned turn through the SAME `{sessionId,agentId,event}`
// contract the Wails shell uses, so the demo renders identically under plain
// `pnpm dev` (no Go side) — see docs/plan/desktop-product.md §3 M4 / §6.

import type {
  WireAuthResult,
  WireConfig,
  WireEvent,
  WireFsHomeResult,
  WireMessage,
  WireModel,
  WireSession,
  WireSessionSnapshot,
  WireSessionUsage,
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
} from './types';

const MOCK_WORKSPACE_ID = 'mock-workspace';
const MOCK_COMMAND = 'echo "hello from the mock engine"';
const MOCK_COMMAND_OUTPUT = 'hello from the mock engine\n';
const MOCK_REPLY_OPENING = 'Sure — let me run a quick command to demonstrate the stream.\n\n';
const MOCK_REPLY_CLOSING =
  '\n\nThe command printed `hello from the mock engine`. This whole turn was ' +
  'simulated by the browser dev mock — no engine is attached.';

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
  private subscribedAgents = new Set<string>();
  private productSeq = 0;
  private productSessionSeq = 0;
  private productPromptSeq = 0;
  private productMsgSeq = 0;
  private productReqSeq = 0;

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
      // Slice 2 clean-boot methods (docs §12.3) — canned wire responses so
      // ?desktop_transport=1 boots in a plain browser without the Go side.
      case 'getAuth':
        data = this.productGetAuth();
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
      case 'listWorkspaces':
        data = this.productListWorkspaces();
        break;
      case 'getFsHome':
        data = this.productGetFsHome();
        break;
      case 'listModels':
        data = this.productListModels();
        break;
      case 'getSessionSnapshot':
        data = this.productGetSessionSnapshot(args[0] as string);
        break;
      default:
        throw new Error(`mock desktop bridge: product method "${method}" is not yet supported`);
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

  async ProductSubscribe(sessionId: string, agentId: string): Promise<void> {
    this.subscribedAgents.add(turnKey(sessionId, agentId));
  }

  onProductEvent(callback: (payload: ProductEventPayload) => void): () => void {
    this.productListeners.add(callback);
    return () => {
      this.productListeners.delete(callback);
    };
  }

  private emitProduct(sessionId: string, agentId: string, event: WireEvent): void {
    const payload: ProductEventPayload = { sessionId, agentId, event };
    for (const listener of [...this.productListeners]) listener(payload);
  }

  /** Build one kimi-web `WireEvent` frame with a monotonic seq + timestamp. */
  private wireFrame(type: string, sessionId: string, payload: unknown): WireEvent {
    return {
      type,
      seq: ++this.productSeq,
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
    this.productSessions.set(id, session);
    return session;
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
  // Slice 2 clean-boot methods (docs §12.3) — canned kap-server wire shapes.
  // ---------------------------------------------------------------------------

  private productGetAuth(): WireAuthResult {
    return {
      ready: true,
      providers_count: 1,
      default_model: 'mock-model',
      managed_provider: { status: 'connected' },
    };
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
    return {
      providers: {
        mock: { type: 'mock', has_api_key: true, default_model: 'mock-model' },
      },
      default_provider: 'mock',
      default_model: 'mock-model',
    };
  }

  private productListWorkspaces(): { items: WireWorkspace[]; has_more: boolean } {
    return {
      items: [
        {
          id: MOCK_WORKSPACE_ID,
          root: '/mock',
          name: 'mock',
          session_count: this.productSessions.size,
        },
      ],
      has_more: false,
    };
  }

  private productGetFsHome(): WireFsHomeResult {
    return { home: '/mock', recent_roots: ['/mock'] };
  }

  private productListModels(): { items: WireModel[] } {
    return {
      items: [
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
      ],
    };
  }

  private productGetSessionSnapshot(sessionId: string): WireSessionSnapshot {
    const session =
      this.productSessions.get(sessionId) ??
      this.mockWireSession(sessionId, `Mock session ${sessionId}`, '/mock');
    return {
      as_of_seq: session.last_seq,
      epoch: 'mock-epoch',
      session,
      messages: { items: [], has_more: false },
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
    for (const listener of [...this.listeners]) listener(payload);
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
