// apps/kimi-web/src/api/desktop/client.ts
// WailsKimiWebApi — the Phase 1 desktop product transport (first vertical
// slice). Implements the chat-loop subset of KimiWebApi over the desktop
// bridge's `ProductCall` / `ProductSubscribe` (frozen contracts E + F, see
// docs/plan/desktop-product.md §11), reusing the daemon's wire types and
// wire→AppEvent pipeline unchanged: responses are kimi-web wire JSON mapped
// with `mappers.ts`, and product `WireEvent`s flow through `toAppEvent` into
// the same `eventReducer` the daemon WS path drives.
//
// ProductCall positional-args contract (S1 sidecar fulfills, S3 here consumes).
// ProductCall returns the RAW kimi-web response wire — the same `WireEnvelope`
// kap-server returns for the matching endpoint (frozen contract E); `call`
// below unwraps it (code 0 → data) exactly like the daemon HTTP transport
// (`http.ts`), so the mappers receive the same unwrapped data either way:
//   listSessions(input?)        → arg [query]            result WirePage<WireSession>
//   createSession(input)        → arg [body]             result WireSession
//   submitPrompt(sid, input)    → arg [sid, wirePrompt]  result WirePromptSubmitResult
//   abortPrompt(sid, promptId)  → arg [sid, promptId]    result { aborted, at_seq? }
//   respondApproval(sid, id, r) → arg [sid, id, wire]    result { resolved, resolved_at }
//   respondQuestion(sid, id, r) → arg [sid, id, wire]    result { resolved, resolved_at }
// `query`/`body`/`wire` are the snake_case kimi-web request wire (the same
// shapes the daemon HTTP client builds); ids are passed positionally.
//
// Methods outside the first slice are not stubbed silently: the factory wraps
// the instance in a Proxy that throws a clear "not yet supported" error for any
// KimiWebApi member the class does not implement.

import type {
  AppConfig,
  AppExpertTeam,
  AppExpertTeamStatus,
  AppGoal,
  AppMessage,
  AppMessageRole,
  AppModel,
  AppProvider,
  AppProviderDetail,
  AppProviderInput,
  AppSession,
  AppSessionRuntimeStatus,
  AppSkill,
  AppTask,
  AppTaskStatus,
  AppTerminal,
  ApprovalResponse,
  AppSessionCursor,
  AppSessionSnapshot,
  AppWorkspace,
  FsBrowseResult,
  FsEntry,
  FsKind,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  OAuthLoginStartResult,
  Page,
  PageRequest,
  ProviderRefreshResult,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResponse,
} from '../types';
import {
  toAppApprovalRequest,
  toAppConfig,
  toAppEvent,
  toAppExpertTeam,
  toAppExpertTeamStatus,
  toAppFsEntry,
  toAppGoal,
  toAppMessage,
  toAppModel,
  toAppProvider,
  toAppQuestionRequest,
  toAppSession,
  toAppTask,
  toAppWorkspace,
  toWireApprovalResponse,
  toWirePromptSubmission,
  toWireQuestionResponse,
  wireEventSeq,
  wireEventSessionId,
} from '../daemon/mappers';
import type {
  WireAuthResult,
  WireConfig,
  WireEnvelope,
  WireExpertTeamDefinition,
  WireExpertTeamSnapshot,
  WireFileMeta,
  WireFsBrowseResult,
  WireFsEntry,
  WireFsHomeResult,
  WireGoalSnapshot,
  WireMessage,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WirePage,
  WirePromptSteerResult,
  WirePromptSubmitResult,
  WireProvider,
  WireProviderDetail,
  WireProviderRefreshResult,
  WireLogoutResult,
  WireSession,
  WireSessionAbortResult,
  WireSessionRuntimeStatus,
  WireSessionSnapshot,
  WireSessionWarning,
  WireTask,
  WireWorkspace,
} from '../daemon/wire';
import { base64FromBytes } from './base64';
import type { DesktopBridge } from './types';

// ---------------------------------------------------------------------------
// Wire response shapes for boot endpoints not in shared wire.ts — mirrored
// field-for-field from the daemon client's local DTOs (daemon/client.ts), which
// in turn match the kap-server healthz / meta routes.
// ---------------------------------------------------------------------------

interface WireHealth {
  status: 'ok';
  uptime_sec: number;
}

interface WireMeta {
  server_version: string;
  server_id: string;
  started_at: string;
  capabilities: Record<string, boolean>;
  open_in_apps?: string[];
  dangerous_bypass_auth?: boolean;
  /** Engine generation serving the API; older (v1) servers omit the field. */
  backend?: 'v1' | 'v2';
}

// ---------------------------------------------------------------------------
// Slice 4 — structured filesystem wire results. Mirrored field-for-field from
// the daemon client's local DTOs (daemon/client.ts), which match the engine's
// `sessionFs` response schemas the sidecar returns unchanged.
// ---------------------------------------------------------------------------

interface WireListDirectoryResult {
  items: WireFsEntry[];
  children_by_path?: Record<string, WireFsEntry[]>;
  truncated: boolean;
}

interface WireReadFileResult {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  truncated: boolean;
  etag: string;
  mime: string;
  language_id?: string;
  line_count?: number;
  is_binary: boolean;
}

interface WireSearchFilesResult {
  items: Array<{
    path: string;
    name: string;
    kind: FsKind;
    score: number;
    match_positions: number[];
  }>;
  truncated: boolean;
}

interface WireGrepFilesResult {
  files: Array<{
    path: string;
    matches: Array<{
      line: number;
      col: number;
      text: string;
      before: string[];
      after: string[];
    }>;
  }>;
  files_scanned: number;
  truncated: boolean;
  elapsed_ms: number;
}

interface WireDiffResult {
  path: string;
  diff: string;
}

// ---------------------------------------------------------------------------
// Slice 6 — session terminals. Mirrored field-for-field from the daemon
// client's local DTO (daemon/client.ts `WireTerminal`); there is no shared
// wire.ts entry, so the desktop client keeps its own copy matching the
// sidecar's kap-server-parity wire exactly.
// ---------------------------------------------------------------------------

interface WireTerminal {
  id: string;
  session_id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  created_at: string;
  exited_at?: string;
  exit_code?: number | null;
}

function toAppTerminal(data: WireTerminal): AppTerminal {
  return {
    id: data.id,
    sessionId: data.session_id,
    cwd: data.cwd,
    shell: data.shell,
    cols: data.cols,
    rows: data.rows,
    status: data.status,
    createdAt: data.created_at,
    exitedAt: data.exited_at,
    exitCode: data.exit_code,
  };
}

/** Conventional main-agent id used to scope the product subscription. */
const MAIN_AGENT_ID = 'main';

/**
 * Slice 5 upload chunk size: 512 KiB raw per `uploadChunk`, ~684 KiB base64 —
 * comfortably inside one NDJSON IPC frame (frozen Slice 5 protocol).
 */
const UPLOAD_CHUNK_BYTES = 512 * 1024;

/**
 * The v2 sync control frame the product stream pushes (instead of a `WireEvent`)
 * when it cannot incrementally cover the resume cursor. Mirrors the sidecar's
 * `WireResyncRequired` and kimi-web's daemon `WireResyncRequired`; the desktop
 * client discriminates it on `type` before mapping normal events.
 */
interface DesktopResyncFrame {
  type: 'resync_required';
  timestamp?: string;
  payload: {
    session_id: string;
    reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed';
    current_seq: number;
    epoch?: string;
  };
}

/** historyCompacted reasons that are compaction itself (no snapshot reload). */
function isCompactionReason(reason: string): boolean {
  return reason === 'auto_compact' || reason === 'manual_compact';
}

export class WailsKimiWebApi {
  private readonly bridge: DesktopBridge;

  constructor(bridge: DesktopBridge) {
    this.bridge = bridge;
  }

  /** ProductCall with a JSON positional-args array; unwraps the response wire. */
  private async call<T>(
    method: string,
    args: unknown[],
    opts?: { allowCodes?: number[] },
  ): Promise<T> {
    const raw = await this.bridge.ProductCall(method, JSON.stringify(args));
    let envelope: WireEnvelope<T>;
    try {
      envelope = JSON.parse(raw) as WireEnvelope<T>;
    } catch (error) {
      throw new Error(`desktop transport: ${method} returned invalid JSON: ${String(error)}`);
    }
    // ProductCall hands back the raw kap-server envelope (frozen contract E).
    // Unwrap it like the daemon HTTP transport: code 0 = success → data, else
    // surface the envelope's code/msg as a transport error — unless the caller
    // opted into allowCodes (e.g. dismissQuestion's 40909 success path).
    const allowCodes = opts?.allowCodes ?? [];
    if (envelope.code !== 0 && !allowCodes.includes(envelope.code)) {
      throw new Error(`desktop transport: ${method} failed (${envelope.code}): ${envelope.msg}`);
    }
    return envelope.data as T;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions(
    input?: PageRequest & {
      busy?: boolean;
      workspaceId?: string;
      includeArchive?: boolean;
      archivedOnly?: boolean;
      excludeEmpty?: boolean;
    },
  ): Promise<Page<AppSession>> {
    const query: Record<string, string | number | boolean | undefined> = {
      before_id: input?.beforeId,
      after_id: input?.afterId,
      page_size: input?.pageSize,
      busy: input?.busy,
      include_archive: input?.includeArchive,
      archived_only: input?.archivedOnly,
      exclude_empty: input?.excludeEmpty,
      workspace_id: input?.workspaceId,
    };
    const data = await this.call<WirePage<WireSession>>('listSessions', [query]);
    return {
      items: data.items.map(toAppSession),
      hasMore: data.has_more,
    };
  }

  async createSession(input: {
    title?: string;
    cwd?: string;
    model?: string;
    workspaceId?: string;
  }): Promise<AppSession> {
    const body: Record<string, unknown> = {
      metadata: input.cwd !== undefined ? { cwd: input.cwd } : {},
    };
    if (input.workspaceId !== undefined) body['workspace_id'] = input.workspaceId;
    if (input.title !== undefined) body['title'] = input.title;
    if (input.model !== undefined) body['agent_config'] = { model: input.model };
    const data = await this.call<WireSession>('createSession', [body]);
    return toAppSession(data);
  }

  // GET /sessions/{id} — deep links / sessions outside the first list page.
  async getSession(sessionId: string): Promise<AppSession> {
    const data = await this.call<WireSession>('getSession', [sessionId]);
    return toAppSession(data);
  }

  async listMessages(
    sessionId: string,
    input?: PageRequest & { role?: AppMessageRole },
  ): Promise<Page<AppMessage>> {
    const query: Record<string, string | number | boolean | undefined> = {
      before_id: input?.beforeId,
      after_id: input?.afterId,
      page_size: input?.pageSize,
      role: input?.role,
    };
    const data = await this.call<WirePage<WireMessage>>('listMessages', [sessionId, query]);
    return {
      items: data.items.map(toAppMessage),
      hasMore: data.has_more,
    };
  }

  /**
   * v2 initial sync: atomic session state at an `as_of_seq` watermark. Mirrors
   * the daemon client's snapshot assembly (daemon/client.ts) field-for-field,
   * reusing the same wire→App mappers so the rebuild flow is identical:
   * getSessionSnapshot() → seedSnapshot() → subscribe(cursor).
   */
  async getSessionSnapshot(sessionId: string): Promise<AppSessionSnapshot> {
    const data = await this.call<WireSessionSnapshot>('getSessionSnapshot', [sessionId]);
    return {
      asOfSeq: data.as_of_seq,
      epoch: data.epoch,
      session: toAppSession(data.session),
      // Snapshot messages are already chronological ascending.
      messages: data.messages.items.map(toAppMessage),
      hasMoreMessages: data.messages.has_more,
      inFlightTurn:
        data.in_flight_turn === null
          ? null
          : {
              turnId: data.in_flight_turn.turn_id,
              assistantText: data.in_flight_turn.assistant_text,
              thinkingText: data.in_flight_turn.thinking_text,
              runningTools: data.in_flight_turn.running_tools.map((t) => ({
                toolCallId: t.tool_call_id,
                name: t.name,
                args: t.args,
                description: t.description,
                lastProgress: t.last_progress,
              })),
              promptId: data.in_flight_turn.current_prompt_id,
            },
      pendingApprovals: data.pending_approvals.map(toAppApprovalRequest),
      pendingQuestions: data.pending_questions.map(toAppQuestionRequest),
      // Older servers omit the roster entirely; treat as an empty roster.
      subagents: (data.subagents ?? []).map(toAppTask),
    };
  }

  // -------------------------------------------------------------------------
  // Health / Meta — boot blockers (docs §12.2). The sidecar may return these
  // statically; the wire shapes match the kap-server healthz / meta routes.
  // -------------------------------------------------------------------------

  async getHealth(): Promise<{ status: 'ok'; uptimeSec: number }> {
    // Real daemon returns { ok: true }; the older shape was { status, uptime_sec }.
    const data = await this.call<Partial<WireHealth>>('getHealth', []);
    return { status: 'ok', uptimeSec: data.uptime_sec ?? 0 };
  }

  async getMeta(): Promise<{
    serverVersion: string;
    serverId: string;
    startedAt: string;
    capabilities: Record<string, boolean>;
    openInApps: string[];
    dangerousBypassAuth: boolean;
    backend: 'v1' | 'v2';
  }> {
    const data = await this.call<WireMeta>('getMeta', []);
    return {
      serverVersion: data.server_version,
      serverId: data.server_id,
      startedAt: data.started_at,
      capabilities: data.capabilities,
      openInApps: Array.isArray(data.open_in_apps) ? data.open_in_apps : [],
      dangerousBypassAuth: data.dangerous_bypass_auth === true,
      backend: data.backend === 'v2' ? 'v2' : 'v1',
    };
  }

  // -------------------------------------------------------------------------
  // Auth — boot blocker (docs §12.2): without it waitForFirstAuth polls forever.
  // -------------------------------------------------------------------------

  async getAuth(): Promise<{
    ready: boolean;
    providersCount: number;
    defaultModel: string | null;
    managedProvider: { status: string } | null;
  }> {
    const data = await this.call<WireAuthResult>('getAuth', []);
    return {
      ready: data.ready,
      providersCount: data.providers_count,
      defaultModel: data.default_model,
      managedProvider: data.managed_provider ? { status: data.managed_provider.status } : null,
    };
  }

  async startOAuthLogin(): Promise<OAuthLoginStartResult> {
    const data = await this.call<WireOAuthLoginStartResult>('startOAuthLogin', []);
    if (data.status === 'authenticated') {
      return {
        flowId: data.flow_id,
        provider: data.provider,
        status: 'authenticated',
      };
    }
    return {
      flowId: data.flow_id,
      provider: data.provider,
      status: 'pending',
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      userCode: data.user_code,
      expiresIn: data.expires_in,
      interval: data.interval,
      expiresAt: data.expires_at,
    };
  }

  async pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null> {
    const data = await this.call<WireOAuthLoginPollResult | null>('pollOAuthLogin', []);
    if (data === null) return null;
    return {
      flowId: data.flow_id,
      status: data.status,
      resolvedAt: data.resolved_at,
    };
  }

  async cancelOAuthLogin(): Promise<{ cancelled: boolean; status: string }> {
    const data = await this.call<WireOAuthCancelResult>('cancelOAuthLogin', []);
    return { cancelled: data.cancelled, status: data.status };
  }

  async logout(): Promise<{ loggedOut: boolean }> {
    const data = await this.call<WireLogoutResult>('logout', []);
    return { loggedOut: data.logged_out };
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  async getConfig(): Promise<AppConfig> {
    const data = await this.call<WireConfig>('getConfig', []);
    return toAppConfig(data);
  }

  // -------------------------------------------------------------------------
  // Workspaces + fs home
  // -------------------------------------------------------------------------

  async listWorkspaces(): Promise<AppWorkspace[]> {
    const data = await this.call<WirePage<WireWorkspace>>('listWorkspaces', []);
    return (data.items ?? []).map(toAppWorkspace);
  }

  // Slice 4 — register a workspace by absolute folder path. Throws on error
  // (e.g. path not found / not a directory) so the caller can surface it.
  async addWorkspace(input: { root: string; name?: string }): Promise<AppWorkspace> {
    const body: Record<string, unknown> = { root: input.root };
    if (input.name !== undefined) body['name'] = input.name;
    const data = await this.call<WireWorkspace>('addWorkspace', [body]);
    return toAppWorkspace(data);
  }

  // Slice 4 — rename a workspace (display name only; never moves the directory).
  async updateWorkspace(id: string, input: { name: string }): Promise<AppWorkspace> {
    const data = await this.call<WireWorkspace>('updateWorkspace', [id, { name: input.name }]);
    return toAppWorkspace(data);
  }

  // Slice 4 — browse directories under `path` (defaults to $HOME in the
  // sidecar). Mirrors the daemon client: a browse failure yields an empty
  // result so the picker can distinguish "failed" from "no children".
  async browseFs(path?: string): Promise<FsBrowseResult> {
    try {
      const data = await this.call<WireFsBrowseResult>('browseFs', [path]);
      return {
        path: data.path,
        parent: data.parent,
        entries: (data.entries ?? []).map((e) => ({
          name: e.name,
          path: e.path,
          isDir: e.is_dir,
        })),
      };
    } catch {
      return { path: '', parent: null, entries: [] };
    }
  }

  async getFsHome(): Promise<{ home: string; recentRoots: string[] }> {
    const data = await this.call<WireFsHomeResult>('getFsHome', []);
    return { home: data.home, recentRoots: data.recent_roots ?? [] };
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  async listModels(): Promise<AppModel[]> {
    const data = await this.call<{ items: WireModel[] }>('listModels', []);
    return data.items.map(toAppModel);
  }

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  async submitPrompt(sessionId: string, input: PromptSubmission): Promise<PromptSubmitResult> {
    const data = await this.call<WirePromptSubmitResult>('submitPrompt', [
      sessionId,
      toWirePromptSubmission(input),
    ]);
    return {
      promptId: data.prompt_id,
      userMessageId: data.user_message_id,
      status: data.status,
    };
  }

  async abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean; atSeq?: number }> {
    const data = await this.call<{ aborted: boolean; at_seq?: number }>('abortPrompt', [
      sessionId,
      promptId,
    ]);
    return { aborted: data.aborted, atSeq: data.at_seq };
  }

  // -------------------------------------------------------------------------
  // Slice 2 — session control (steer / abort / compact / undo / fork /
  // children / BTW). Each mirrors the daemon client's REST call, routed
  // through ProductCall to the sidecar facade's kap-server-parity handlers.
  // -------------------------------------------------------------------------

  // prompts:steer — steer daemon-queued prompts into the active turn. Throws
  // PROMPT_NOT_FOUND when there is no active turn anymore (callers may treat
  // that as success — the queued prompt then starts its own turn).
  async steerPrompts(
    sessionId: string,
    promptIds: string[],
  ): Promise<{ steered: boolean; promptIds: string[] }> {
    const data = await this.call<WirePromptSteerResult>('steerPrompts', [
      sessionId,
      { prompt_ids: promptIds },
    ]);
    return { steered: data.steered, promptIds: data.prompt_ids };
  }

  // sessions/{id}:abort — cancel whatever is running in the session, keeping
  // the idempotent success semantics when the session is idle.
  async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    const data = await this.call<WireSessionAbortResult>('abortSession', [sessionId]);
    return { aborted: data.aborted };
  }

  // sessions/{id}:compact — request history compaction. Returns {}; progress
  // and completion arrive via the compaction.* product events.
  async compactSession(sessionId: string, instruction?: string): Promise<void> {
    await this.call('compactSession', [sessionId, instruction ? { instruction } : {}]);
  }

  // sessions/{id}:undo — remove the last `count` turns. The wire response
  // carries messages + status, but like the daemon client we only need the
  // call to succeed (callers re-sync the session afterwards).
  async undoSession(sessionId: string, count = 1): Promise<void> {
    await this.call('undoSession', [sessionId, { count }]);
  }

  // sessions/{id}:fork — fork the session into a new session.
  async forkSession(sessionId: string, input?: { title?: string }): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input?.title !== undefined) body['title'] = input.title;
    const data = await this.call<WireSession>('forkSession', [sessionId, body]);
    return toAppSession(data);
  }

  // sessions/{id}/children — create a child ("side chat") session inheriting
  // the parent's context, tagged with parent_session_id.
  async createChildSession(sessionId: string, input?: { title?: string }): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input?.title !== undefined) body['title'] = input.title;
    const data = await this.call<WireSession>('createChildSession', [sessionId, body]);
    return toAppSession(data);
  }

  // sessions/{id}/children — list a session's child sessions.
  async listChildSessions(sessionId: string): Promise<AppSession[]> {
    const data = await this.call<WirePage<WireSession>>('listChildSessions', [sessionId]);
    return data.items.map(toAppSession);
  }

  // sessions/{id}:btw — start a side-channel agent; follow-up prompts use the
  // returned agent_id on the normal prompt route.
  async startBtw(sessionId: string): Promise<{ agentId: string }> {
    const data = await this.call<{ agent_id: string }>('startBtw', [sessionId]);
    return { agentId: data.agent_id };
  }

  // -------------------------------------------------------------------------
  // Approval / Question
  // -------------------------------------------------------------------------

  async respondApproval(
    sessionId: string,
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<{ resolved: true; resolvedAt: string }> {
    const data = await this.call<{ resolved: true; resolved_at: string }>('respondApproval', [
      sessionId,
      approvalId,
      toWireApprovalResponse(response),
    ]);
    return { resolved: data.resolved, resolvedAt: data.resolved_at };
  }

  async respondQuestion(
    sessionId: string,
    questionId: string,
    response: QuestionResponse,
  ): Promise<{ resolved: true; resolvedAt: string }> {
    const data = await this.call<{ resolved: true; resolved_at: string }>('respondQuestion', [
      sessionId,
      questionId,
      toWireQuestionResponse(response),
    ]);
    return { resolved: data.resolved, resolvedAt: data.resolved_at };
  }

  async dismissQuestion(
    sessionId: string,
    questionId: string,
  ): Promise<{ dismissed: true; dismissedAt: string }> {
    const data = await this.call<{ dismissed: true; dismissed_at: string }>(
      'dismissQuestion',
      [sessionId, questionId],
      { allowCodes: [40909] },
    );
    return { dismissed: true, dismissedAt: data.dismissed_at };
  }

  // -------------------------------------------------------------------------
  // Slice A — session-level read methods. Each mirrors the daemon client's
  // REST call, routed through ProductCall. Responses are wire JSON unwrapped
  // and mapped to App* types with the same daemon mappers.
  // -------------------------------------------------------------------------

  async getSessionStatus(sessionId: string): Promise<AppSessionRuntimeStatus> {
    const data = await this.call<WireSessionRuntimeStatus>('getSessionStatus', [sessionId]);
    return {
      model: data.model && data.model.length > 0 ? data.model : null,
      thinkingEffort: data.thinking_level,
      permission: data.permission,
      planMode: data.plan_mode === true,
      swarmMode: data.swarm_mode === true,
      contextTokens: data.context_tokens ?? 0,
      maxContextTokens: data.max_context_tokens ?? 0,
      contextUsage: data.context_usage ?? 0,
    };
  }

  async getSessionGoal(sessionId: string): Promise<AppGoal | null> {
    const data = await this.call<WireGoalSnapshot | null>('getSessionGoal', [sessionId]);
    return toAppGoal(data);
  }

  async getSessionWarnings(sessionId: string): Promise<WireSessionWarning[]> {
    const data = await this.call<{ warnings: WireSessionWarning[] }>('getSessionWarnings', [sessionId]);
    return data.warnings ?? [];
  }

  async listSkills(sessionId: string): Promise<AppSkill[]> {
    const data = await this.call<{ skills: { name: string; description: string; source: string }[] }>(
      'listSkills',
      [sessionId],
    );
    return (data.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
    }));
  }

  async listTasks(sessionId: string, status?: AppTaskStatus): Promise<AppTask[]> {
    const data = await this.call<{ items: WireTask[] }>('listTasks', [
      sessionId,
      status,
    ]);
    return data.items.map(toAppTask);
  }

  async getTask(
    sessionId: string,
    taskId: string,
    input?: { withOutput?: boolean; outputBytes?: number },
  ): Promise<AppTask> {
    const query: Record<string, string | number | boolean | undefined> = {
      with_output: input?.withOutput,
      output_bytes: input?.outputBytes,
    };
    const data = await this.call<WireTask>('getTask', [sessionId, taskId, query]);
    return toAppTask(data);
  }

  async cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    const data = await this.call<{ cancelled: true }>('cancelTask', [sessionId, taskId]);
    return data;
  }

  // -------------------------------------------------------------------------
  // Slice 6 — session terminals (CRUD). Input/resize/attach/detach live on the
  // connectEvents connection below; these are the REST read/create/close calls,
  // routed through ProductCall to the sidecar facade's ISessionTerminalService
  // handlers. Wire shapes match the daemon client field-for-field.
  // -------------------------------------------------------------------------

  async listTerminals(sessionId: string): Promise<AppTerminal[]> {
    const data = await this.call<{ items: WireTerminal[] }>('listTerminals', [sessionId]);
    return data.items.map(toAppTerminal);
  }

  async createTerminal(
    sessionId: string,
    input: { cwd?: string; shell?: string; cols?: number; rows?: number } = {},
  ): Promise<AppTerminal> {
    const body: Record<string, unknown> = {
      cwd: input.cwd,
      shell: input.shell,
      cols: input.cols,
      rows: input.rows,
    };
    const data = await this.call<WireTerminal>('createTerminal', [sessionId, body]);
    return toAppTerminal(data);
  }

  async getTerminal(sessionId: string, terminalId: string): Promise<AppTerminal> {
    const data = await this.call<WireTerminal>('getTerminal', [sessionId, terminalId]);
    return toAppTerminal(data);
  }

  async closeTerminal(sessionId: string, terminalId: string): Promise<{ closed: true }> {
    return this.call<{ closed: true }>('closeTerminal', [sessionId, terminalId]);
  }

  async getGitStatus(
    sessionId: string,
    paths?: string[],
  ): Promise<{
    branch: string;
    ahead: number;
    behind: number;
    entries: Record<string, string>;
    additions: number;
    deletions: number;
    pullRequest: { number: number; state: string; url: string } | null;
  }> {
    const data = await this.call<{
      branch: string;
      ahead: number;
      behind: number;
      entries: Record<string, string>;
      additions: number;
      deletions: number;
      pullRequest?: { number: number; state: string; url: string } | null;
    }>('getGitStatus', [sessionId, paths]);
    return {
      branch: data.branch,
      ahead: data.ahead,
      behind: data.behind,
      entries: data.entries,
      additions: data.additions,
      deletions: data.deletions,
      pullRequest: data.pullRequest ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Slice 4 — structured session filesystem (P1). Each mirrors the daemon
  // client's `fs:<action>` REST call, routed through ProductCall to the
  // sidecar facade's ISessionFsService handlers. Request bodies are snake_case
  // wire; responses are the engine's wire shapes mapped to the App contracts.
  // -------------------------------------------------------------------------

  async listDirectory(
    sessionId: string,
    input: { path?: string; depth?: number; includeGitStatus?: boolean },
  ): Promise<{ items: FsEntry[]; childrenByPath?: Record<string, FsEntry[]>; truncated: boolean }> {
    const body: Record<string, unknown> = {};
    if (input.path !== undefined) body['path'] = input.path;
    if (input.depth !== undefined) body['depth'] = input.depth;
    if (input.includeGitStatus !== undefined) body['include_git_status'] = input.includeGitStatus;
    const data = await this.call<WireListDirectoryResult>('listDirectory', [sessionId, body]);
    const childrenByPath = data.children_by_path
      ? Object.fromEntries(
          Object.entries(data.children_by_path).map(([k, v]) => [k, v.map(toAppFsEntry)]),
        )
      : undefined;
    return {
      items: data.items.map(toAppFsEntry),
      childrenByPath,
      truncated: data.truncated,
    };
  }

  async readFile(
    sessionId: string,
    input: { path: string; offset?: number; length?: number },
  ): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    size: number;
    truncated: boolean;
    etag: string;
    mime: string;
    languageId?: string;
    lineCount?: number;
    isBinary: boolean;
  }> {
    const body: Record<string, unknown> = { path: input.path };
    if (input.offset !== undefined) body['offset'] = input.offset;
    if (input.length !== undefined) body['length'] = input.length;
    const data = await this.call<WireReadFileResult>('readFile', [sessionId, body]);
    return {
      path: data.path,
      content: data.content,
      encoding: data.encoding,
      size: data.size,
      truncated: data.truncated,
      etag: data.etag,
      mime: data.mime,
      languageId: data.language_id,
      lineCount: data.line_count,
      isBinary: data.is_binary,
    };
  }

  async searchFiles(
    sessionId: string,
    input: { query: string; limit?: number },
  ): Promise<{
    items: Array<{ path: string; name: string; kind: FsKind; score: number; matchPositions: number[] }>;
    truncated: boolean;
  }> {
    const body: Record<string, unknown> = { query: input.query };
    if (input.limit !== undefined) body['limit'] = input.limit;
    const data = await this.call<WireSearchFilesResult>('searchFiles', [sessionId, body]);
    return {
      items: data.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind,
        score: item.score,
        matchPositions: item.match_positions,
      })),
      truncated: data.truncated,
    };
  }

  async grepFiles(
    sessionId: string,
    input: { pattern: string; regex?: boolean; caseSensitive?: boolean },
  ): Promise<{
    files: Array<{
      path: string;
      matches: Array<{ line: number; col: number; text: string; before: string[]; after: string[] }>;
    }>;
    filesScanned: number;
    truncated: boolean;
    elapsedMs: number;
  }> {
    const body: Record<string, unknown> = { pattern: input.pattern };
    if (input.regex !== undefined) body['regex'] = input.regex;
    if (input.caseSensitive !== undefined) body['case_sensitive'] = input.caseSensitive;
    const data = await this.call<WireGrepFilesResult>('grepFiles', [sessionId, body]);
    return {
      files: data.files,
      filesScanned: data.files_scanned,
      truncated: data.truncated,
      elapsedMs: data.elapsed_ms,
    };
  }

  async getFileDiff(sessionId: string, path: string): Promise<{ path: string; diff: string }> {
    const data = await this.call<WireDiffResult>('getFileDiff', [sessionId, path]);
    return { path: data.path, diff: data.diff };
  }

  // Native open operations — the sidecar resolves the workspace-bounded path
  // and launches the platform handler (no terminal window), mirroring kap-server.
  async openFile(sessionId: string, input: { path: string; line?: number }): Promise<{ opened: true }> {
    const body: Record<string, unknown> = { path: input.path };
    if (input.line !== undefined) body['line'] = input.line;
    return this.call<{ opened: true }>('openFile', [sessionId, body]);
  }

  async revealFile(sessionId: string, input: { path: string }): Promise<{ revealed: true }> {
    return this.call<{ revealed: true }>('revealFile', [sessionId, { path: input.path }]);
  }

  async openInApp(sessionId: string, appId: string, path: string, line?: number): Promise<void> {
    await this.call<{ opened: true }>('openInApp', [sessionId, appId, path, line]);
  }

  // -------------------------------------------------------------------------
  // Slice 5 — binary files. Uploads chunk the Blob into 512 KiB base64 pieces
  // through ProductCall (uploadStart / uploadChunk / uploadFinish, kap-server
  // WireFileMeta wire); downloads stream base64 frames over `kimi:stream` and
  // assemble into a Blob via bridge.streamToBlob. The HTTP-only URL getters
  // have no desktop equivalent — there is no HTTP hop to authenticate — so
  // they throw and point callers at the Blob methods instead.
  // -------------------------------------------------------------------------

  async uploadFile(input: {
    file: Blob;
    name?: string;
  }): Promise<{ id: string; name: string; mediaType: string; size: number }> {
    const name = input.name ?? (input.file instanceof File ? input.file.name : 'upload');
    const mediaType = input.file.type !== '' ? input.file.type : 'application/octet-stream';
    const start = await this.call<{ upload_id: string }>('uploadStart', [
      { name, media_type: mediaType },
    ]);
    const uploadId = start.upload_id;
    for (let offset = 0; offset < input.file.size; offset += UPLOAD_CHUNK_BYTES) {
      const slice = input.file.slice(offset, offset + UPLOAD_CHUNK_BYTES);
      const chunk = base64FromBytes(new Uint8Array(await slice.arrayBuffer()));
      await this.call<{ received: number }>('uploadChunk', [uploadId, chunk]);
    }
    const meta = await this.call<WireFileMeta>('uploadFinish', [uploadId]);
    return { id: meta.id, name: meta.name, mediaType: meta.media_type, size: meta.size };
  }

  async getFileBlob(fileId: string): Promise<Blob> {
    return this.bridge.streamToBlob('getFileBlob', [fileId]);
  }

  getFileUrl(_fileId: string): string {
    throw new Error(
      'desktop transport: getFileUrl is not available without HTTP — use getFileBlob() instead',
    );
  }

  getFileDownloadUrl(_sessionId: string, _path: string): string {
    throw new Error(
      'desktop transport: getFileDownloadUrl is not available without HTTP — use getWorkspaceFileBlob() instead',
    );
  }

  /** Download a session workspace file's bytes over the IPC stream. */
  async getWorkspaceFileBlob(sessionId: string, path: string): Promise<Blob> {
    return this.bridge.streamToBlob('getWorkspaceFileBlob', [sessionId, path]);
  }

  // -------------------------------------------------------------------------
  // Slice C — write methods. Each mirrors the daemon client, routed through
  // ProductCall. Bodies are built snake_case to match the wire, responses are
  // unwrapped and mapped to App* types with the same daemon mappers.
  // -------------------------------------------------------------------------

  async updateSession(
    sessionId: string,
    input: {
      title?: string;
      cwd?: string;
      model?: string;
      permissionMode?: string;
      planMode?: boolean;
      swarmMode?: boolean;
      goalObjective?: string;
      goalControl?: 'pause' | 'resume' | 'cancel';
      thinking?: string;
    },
  ): Promise<AppSession> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body['title'] = input.title;
    if (input.cwd !== undefined) body['metadata'] = { cwd: input.cwd };
    const agentConfig: Record<string, unknown> = {};
    if (input.model !== undefined) agentConfig['model'] = input.model;
    if (input.permissionMode !== undefined) agentConfig['permission_mode'] = input.permissionMode;
    if (input.planMode !== undefined) agentConfig['plan_mode'] = input.planMode;
    if (input.swarmMode !== undefined) agentConfig['swarm_mode'] = input.swarmMode;
    if (input.goalObjective !== undefined) agentConfig['goal_objective'] = input.goalObjective;
    if (input.goalControl !== undefined) agentConfig['goal_control'] = input.goalControl;
    if (input.thinking !== undefined) agentConfig['thinking'] = input.thinking;
    if (Object.keys(agentConfig).length > 0) body['agent_config'] = agentConfig;
    const data = await this.call<WireSession>('updateSession', [sessionId, body]);
    return toAppSession(data);
  }

  async setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const wirePatch: Record<string, unknown> = {};
    const keyMap: Record<string, string> = {
      providers: 'providers',
      defaultProvider: 'default_provider',
      defaultModel: 'default_model',
      models: 'models',
      thinking: 'thinking',
      planMode: 'plan_mode',
      yolo: 'yolo',
      defaultPermissionMode: 'default_permission_mode',
      defaultPlanMode: 'default_plan_mode',
      permission: 'permission',
      hooks: 'hooks',
      services: 'services',
      mergeAllAvailableSkills: 'merge_all_available_skills',
      extraSkillDirs: 'extra_skill_dirs',
      loopControl: 'loop_control',
      background: 'background',
      experimental: 'experimental',
      telemetry: 'telemetry',
      raw: 'raw',
    };
    for (const [key, value] of Object.entries(patch)) {
      const wireKey = keyMap[key];
      if (wireKey !== undefined) wirePatch[wireKey] = value;
    }
    const data = await this.call<WireConfig>('setConfig', [wirePatch]);
    return toAppConfig(data);
  }

  async archiveSession(sessionId: string): Promise<{ archived: true }> {
    await this.call<{ archived: boolean }>('archiveSession', [sessionId]);
    return { archived: true };
  }

  async restoreSession(sessionId: string): Promise<AppSession> {
    const data = await this.call<WireSession>('restoreSession', [sessionId]);
    return toAppSession(data);
  }

  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    await this.call<{ deleted: boolean }>('deleteSession', [sessionId]);
    return { deleted: true };
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.call<{ deleted: boolean }>('deleteWorkspace', [id]);
  }

  // -------------------------------------------------------------------------
  // Slice B — provider/model methods.
  // -------------------------------------------------------------------------

  async listProviders(): Promise<AppProvider[]> {
    const data = await this.call<{ items: WireProvider[] }>('listProviders', []);
    return (data.items ?? []).map(toAppProvider);
  }

  async getProvider(id: string): Promise<AppProviderDetail> {
    const data = await this.call<WireProviderDetail>('getProvider', [id]);
    return { ...toAppProvider(data), apiKey: data.api_key };
  }

  async createProvider(input: AppProviderInput): Promise<AppProvider> {
    const data = await this.call<WireProvider>('createProvider', [providerRequestBody(input)]);
    return toAppProvider(data);
  }

  async replaceProvider(id: string, input: AppProviderInput): Promise<AppProvider> {
    const body = providerRequestBody(input);
    delete body['id'];
    if (input.id !== id) body['new_id'] = input.id;
    const data = await this.call<{ provider: WireProvider }>('replaceProvider', [id, body]);
    return toAppProvider(data.provider);
  }

  async deleteProvider(id: string): Promise<{ deleted: true }> {
    await this.call<{ deleted: boolean }>('deleteProvider', [id]);
    return { deleted: true };
  }

  async refreshProvider(id: string): Promise<ProviderRefreshResult> {
    const data = await this.call<WireProviderRefreshResult>('refreshProvider', [id]);
    return toProviderRefreshResult(data);
  }

  async refreshAllProviders(): Promise<ProviderRefreshResult> {
    const data = await this.call<WireProviderRefreshResult>('refreshAllProviders', []);
    return toProviderRefreshResult(data);
  }

  async setDefaultModel(modelId: string): Promise<void> {
    await this.call('setDefaultModel', [modelId]);
  }

  async refreshOAuthProviderModels(): Promise<ProviderRefreshResult> {
    const data = await this.call<WireProviderRefreshResult>('refreshOAuthProviderModels', []);
    return toProviderRefreshResult(data);
  }

  // -------------------------------------------------------------------------
  // Expert teams (v2) — Modes menu / /experts.
  // -------------------------------------------------------------------------

  async listExpertTeams(sessionId: string): Promise<AppExpertTeam[]> {
    const data = await this.call<{ experts: WireExpertTeamDefinition[] }>('listExpertTeams', [
      sessionId,
    ]);
    return (data.experts ?? []).map(toAppExpertTeam);
  }

  async getExpertTeam(sessionId: string): Promise<AppExpertTeamStatus | null> {
    const data = await this.call<{ expert_team: WireExpertTeamSnapshot | null }>('getExpertTeam', [
      sessionId,
    ]);
    return data.expert_team === null ? null : toAppExpertTeamStatus(data.expert_team);
  }

  async activateExpertTeam(sessionId: string, pluginId: string): Promise<AppExpertTeamStatus> {
    const data = await this.call<{ expert_team: WireExpertTeamSnapshot }>('activateExpertTeam', [
      sessionId,
      { plugin_id: pluginId },
    ]);
    return toAppExpertTeamStatus(data.expert_team);
  }

  async deactivateExpertTeam(sessionId: string): Promise<void> {
    await this.call<{ deactivated: true }>('deactivateExpertTeam', [sessionId]);
  }

  // -------------------------------------------------------------------------
  // Events — feed product WireEvents into the daemon's toAppEvent pipeline, with
  // real v2 sync state: per-session resume cursors, journal-backed catch-up on
  // (re)subscribe, `resync_required` handling, and unsubscribe/reconnect.
  // -------------------------------------------------------------------------

  connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    // Latest known cursor per session (advanced by every sequenced frame and by
    // seedSnapshot); reused when (re)subscribing so a reconnect resumes from the
    // journal instead of re-reading everything.
    const cursors = new Map<string, AppSessionCursor>();
    // Sessions with an active bridge subscription — the set reconnect() resumes.
    const subscribed = new Set<string>();
    let connected = true;

    const advanceCursor = (sessionId: string, seq: number): void => {
      if (!Number.isFinite(seq) || seq <= 0) return;
      const prev = cursors.get(sessionId);
      if (prev === undefined || seq > prev.seq) {
        cursors.set(sessionId, { seq, epoch: prev?.epoch });
      }
    };

    const off = this.bridge.onProductEvent((payload) => {
      // v2 sync control frame: the stream could not incrementally cover our
      // cursor. Adopt its watermark and ask the app layer to re-read the
      // snapshot — never silently continue past the hole. Inspected loosely
      // because `WireEvent`'s unknown member has `type: string` and cannot
      // discriminate the control frame at the type level.
      const control = payload.event as unknown as Partial<DesktopResyncFrame>;
      if (control.type === 'resync_required' && control.payload !== undefined) {
        const { session_id: sessionId, current_seq: currentSeq, epoch } = control.payload;
        cursors.set(sessionId, { seq: currentSeq, epoch });
        handlers.onResync(sessionId, currentSeq, epoch);
        return;
      }

      const wireEvent = payload.event;
      const sessionId = wireEventSessionId(wireEvent);
      const seq = wireEventSeq(wireEvent);
      const appEvent = toAppEvent(wireEvent);

      // Advance the durable cursor so a later reconnect resumes past this frame.
      if (sessionId.length > 0) advanceCursor(sessionId, seq);

      // Mirror the daemon WS path: a non-compaction historyCompacted means the
      // cached transcript is stale → resync. The event still advances lastSeq.
      if (appEvent.type === 'historyCompacted' && !isCompactionReason(appEvent.reason)) {
        handlers.onResync(appEvent.sessionId, appEvent.beforeSeq);
      }

      handlers.onEvent(appEvent, { sessionId, seq });
    });

    // Slice 6 terminal frames ride the dedicated `kimi:terminal` channel (never
    // the chat `kimi:event` stream); fan them out to the optional terminal
    // handlers based on the frame type.
    const terminalOff = this.bridge.onTerminalEvent((event) => {
      if (event.type === 'output') {
        handlers.onTerminalOutput?.(event.sessionId, event.terminalId, event.data ?? '', event.seq ?? 0);
      } else {
        handlers.onTerminalExit?.(event.sessionId, event.terminalId, event.exitCode ?? null);
      }
    });

    handlers.onConnectionChange(true);

    const doSubscribe = (sessionId: string): void => {
      const cursor = cursors.get(sessionId);
      const streamCursor =
        cursor === undefined ? undefined : { epoch: cursor.epoch, afterSeq: cursor.seq };
      void this.bridge.ProductSubscribe(sessionId, MAIN_AGENT_ID, streamCursor).then(
        () => {
          if (!connected) {
            connected = true;
            handlers.onConnectionChange(true);
          }
        },
        (error: unknown) => {
          connected = false;
          handlers.onConnectionChange(false);
          handlers.onError(0, `desktop transport: subscribe failed: ${String(error)}`, false);
        },
      );
    };

    return {
      subscribe: (sessionId: string, cursor?: AppSessionCursor): void => {
        if (cursor !== undefined) cursors.set(sessionId, cursor);
        subscribed.add(sessionId);
        doSubscribe(sessionId);
      },
      unsubscribe: (sessionId: string): void => {
        subscribed.delete(sessionId);
        // Keep the cursor: a quick re-open resumes cheaply from the journal.
        void this.bridge.ProductUnsubscribe(sessionId, MAIN_AGENT_ID).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: unsubscribe failed: ${String(error)}`, false);
        });
      },
      seedSnapshot: (sessionId: string, snapshot: AppSessionSnapshot): void => {
        // Record the snapshot watermark so the subscribe() that follows resumes
        // exactly at it (the sidecar projects live WireEvents; there is no
        // client-side projector to seed on this transport).
        cursors.set(sessionId, { seq: snapshot.asOfSeq, epoch: snapshot.epoch });
      },
      bindNextPromptId: (_sessionId: string, _promptId: string): void => {
        // The product layer owns prompt ids; no client-side synthesis to bind.
      },
      abort: (sessionId: string, promptId: string): void => {
        void this.abortPrompt(sessionId, promptId).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: abort failed: ${String(error)}`, false);
        });
      },
      terminalAttach: (sessionId: string, terminalId: string, sinceSeq?: number): void => {
        void this.bridge.ProductTerminalAttach(sessionId, terminalId, sinceSeq).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: terminal attach failed: ${String(error)}`, false);
        });
      },
      terminalInput: (sessionId: string, terminalId: string, data: string): void => {
        void this.call('terminalInput', [sessionId, terminalId, data]).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: terminal input failed: ${String(error)}`, false);
        });
      },
      terminalResize: (sessionId: string, terminalId: string, cols: number, rows: number): void => {
        void this.call('terminalResize', [sessionId, terminalId, cols, rows]).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: terminal resize failed: ${String(error)}`, false);
        });
      },
      terminalDetach: (sessionId: string, terminalId: string): void => {
        void this.bridge.ProductTerminalDetach(sessionId, terminalId).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: terminal detach failed: ${String(error)}`, false);
        });
      },
      terminalClose: (sessionId: string, terminalId: string): void => {
        void this.call('terminalClose', [sessionId, terminalId]).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: terminal close failed: ${String(error)}`, false);
        });
      },
      markSideChannelAgent: (_agentId: string): void => {
        // No-op on this transport: side-channel (BTW) agent projection lives in
        // the sidecar, which currently projects only the main agent. Multi-agent
        // projection is a follow-up; there is no client-side projector to mark.
      },
      health: (): { connected: boolean; open: boolean; stale: boolean } => ({
        // The desktop IPC is owned by the Go shell and shares the webview
        // lifetime, so there is no background-tab half-open state to detect;
        // `connected` only drops when a subscribe call itself failed.
        connected,
        open: connected,
        stale: false,
      }),
      reconnect: (): void => {
        // Re-subscribe every active session at its last cursor; the sidecar
        // journal catches each up (or sends resync_required).
        for (const sessionId of subscribed) doSubscribe(sessionId);
      },
      close: (): void => {
        for (const sessionId of subscribed) {
          void this.bridge.ProductUnsubscribe(sessionId, MAIN_AGENT_ID).catch(() => undefined);
        }
        subscribed.clear();
        off();
        terminalOff();
      },
    };
  }
}

/**
 * Wrap a WailsKimiWebApi in the full KimiWebApi surface. The first-slice
 * methods + connectEvents are real; every other KimiWebApi member resolves to a
 * function that throws a clear "not yet supported on desktop transport" error
 * (never a silent stub). The Proxy keeps this forward-compatible: newly added
 * KimiWebApi methods throw until a later slice implements them.
 */
export function createWailsKimiWebApi(bridge: DesktopBridge): KimiWebApi {
  const impl = new WailsKimiWebApi(bridge);
  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(target);
      if (value !== undefined || typeof prop === 'symbol') return value;
      // Never appear thenable (e.g. if the singleton is accidentally awaited).
      if (prop === 'then') return undefined;
      return (): never => {
        throw new Error(
          `desktop transport: "${String(prop)}" is not yet supported on the desktop product transport (first slice only)`,
        );
      };
    },
  }) as unknown as KimiWebApi;
}

/** Mirrors the daemon client's `providerRequestBody` (client.ts). */
function providerRequestBody(input: AppProviderInput): Record<string, unknown> {
  const models = input.models.map((row) => {
    const model: Record<string, unknown> = {
      model: row.model,
      max_context_size: row.maxContextSize,
    };
    if (row.displayName !== undefined && row.displayName !== '') {
      model['display_name'] = row.displayName;
    }
    return model;
  });
  const body: Record<string, unknown> = { id: input.id, type: input.type, models };
  if (input.apiKey !== undefined) body['api_key'] = input.apiKey;
  if (input.baseUrl !== undefined && input.baseUrl !== '') body['base_url'] = input.baseUrl;
  if (input.defaultModel !== undefined && input.defaultModel !== '') {
    body['default_model'] = input.defaultModel;
  }
  return body;
}

function toProviderRefreshResult(data: WireProviderRefreshResult): ProviderRefreshResult {
  return {
    changed: data.changed.map((item) => ({
      providerId: item.provider_id,
      providerName: item.provider_name,
      added: item.added,
      removed: item.removed,
    })),
    unchanged: data.unchanged,
    failed: data.failed,
  };
}
