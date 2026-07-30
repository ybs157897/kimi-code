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
  AppGoal,
  AppModel,
  AppProvider,
  AppProviderDetail,
  AppProviderInput,
  AppSession,
  AppSessionRuntimeStatus,
  AppSkill,
  AppTask,
  AppTaskStatus,
  ApprovalResponse,
  AppSessionCursor,
  AppSessionSnapshot,
  AppWorkspace,
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
  WireEvent,
  WireFsHomeResult,
  WireGoalSnapshot,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WirePage,
  WirePromptSubmitResult,
  WireProvider,
  WireProviderDetail,
  WireProviderRefreshResult,
  WireLogoutResult,
  WireSession,
  WireSessionRuntimeStatus,
  WireSessionSnapshot,
  WireSessionWarning,
  WireTask,
  WireWorkspace,
} from '../daemon/wire';
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

/** Conventional main-agent id used to scope the product subscription. */
const MAIN_AGENT_ID = 'main';

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
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    const raw = await this.bridge.ProductCall(method, JSON.stringify(args));
    let envelope: WireEnvelope<T>;
    try {
      envelope = JSON.parse(raw) as WireEnvelope<T>;
    } catch (error) {
      throw new Error(`desktop transport: ${method} returned invalid JSON: ${String(error)}`);
    }
    // ProductCall hands back the raw kap-server envelope (frozen contract E).
    // Unwrap it like the daemon HTTP transport: code 0 = success → data, else
    // surface the envelope's code/msg as a transport error.
    if (envelope.code !== 0) {
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

  async deleteProvider(id: string): Promise<{ deleted: true }> {
    await this.call<{ deleted: boolean }>('deleteProvider', [id]);
    return { deleted: true };
  }

  async setDefaultModel(modelId: string): Promise<void> {
    await this.call('setDefaultModel', [modelId]);
  }

  async refreshOAuthProviderModels(): Promise<ProviderRefreshResult> {
    const data = await this.call<WireProviderRefreshResult>('refreshOAuthProviderModels', []);
    return toProviderRefreshResult(data);
  }

  // -------------------------------------------------------------------------
  // Events — feed product WireEvents into the daemon's toAppEvent pipeline.
  // -------------------------------------------------------------------------

  connectEvents(handlers: KimiEventHandlers): KimiEventConnection {
    const off = this.bridge.onProductEvent((payload) => {
      const wireEvent: WireEvent = payload.event;
      const sessionId = wireEventSessionId(wireEvent);
      const seq = wireEventSeq(wireEvent);
      const appEvent = toAppEvent(wireEvent);

      // Mirror the daemon WS path: a non-compaction historyCompacted means the
      // cached transcript is stale → resync. The event still advances lastSeq.
      if (appEvent.type === 'historyCompacted' && !isCompactionReason(appEvent.reason)) {
        handlers.onResync(appEvent.sessionId, appEvent.beforeSeq);
      }

      handlers.onEvent(appEvent, { sessionId, seq });
    });

    handlers.onConnectionChange(true);

    return {
      subscribe: (sessionId: string, _cursor?: AppSessionCursor): void => {
        void this.bridge.ProductSubscribe(sessionId, MAIN_AGENT_ID).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: subscribe failed: ${String(error)}`, false);
        });
      },
      unsubscribe: (_sessionId: string): void => {
        // First slice keeps the product stream attached for the page lifetime.
      },
      seedSnapshot: (_sessionId: string, _snapshot: AppSessionSnapshot): void => {
        // No client-side projector on this transport; the product layer streams
        // live WireEvents. Snapshot seeding is a later slice.
      },
      bindNextPromptId: (_sessionId: string, _promptId: string): void => {
        // The product layer owns prompt ids; no client-side synthesis to bind.
      },
      abort: (sessionId: string, promptId: string): void => {
        void this.abortPrompt(sessionId, promptId).catch((error: unknown) => {
          handlers.onError(0, `desktop transport: abort failed: ${String(error)}`, false);
        });
      },
      terminalAttach: (): void => undefined,
      terminalInput: (): void => undefined,
      terminalResize: (): void => undefined,
      terminalDetach: (): void => undefined,
      terminalClose: (): void => undefined,
      markSideChannelAgent: (_agentId: string): void => undefined,
      health: (): { connected: boolean; open: boolean; stale: boolean } => ({
        connected: true,
        open: true,
        stale: false,
      }),
      reconnect: (): void => undefined,
      close: (): void => {
        off();
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
