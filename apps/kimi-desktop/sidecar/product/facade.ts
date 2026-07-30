/**
 * Product facade — fulfills the first-slice `desktopProduct` methods through an
 * in-process klient (`createKlient({ scope })`, zod-validated) and returns the
 * same kimi-web response wire JSON kap-server returns for each endpoint (wrapped
 * in the `WireEnvelope` the daemon transport unwraps). Session "work" facts are
 * read from the engine's `ISessionActivityView` exactly like kap-server's
 * `resolveSessionFacts` — the sidecar IS the host process, so it reaches the
 * scope directly for that one pure projection while every operation still goes
 * through the klient facade.
 */

import type { AgentHandle, Klient } from '@moonshot-ai/klient';
import type { ScopeLike } from '@moonshot-ai/klient/memory';
import { RPCError } from '@moonshot-ai/klient';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';
import {
  ISessionLegacyService,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionLegacy';
import { ISessionActivityView } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionActivity';
import type { QuestionAnswers } from '@moonshot-ai/agent-core-v2/session/question/question';
import { isError2 } from '@moonshot-ai/agent-core-v2/_base/errors/errors';
import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentTaskService,
  IAuthLegacyService,
  IConfigService,
  ISessionContext,
  ISessionFsService,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionSecondaryModelWarningService,
  ISessionSkillCatalog,
  IWorkspaceService,
  IWorkspaceSessions,
  SECONDARY_DERIVED_MODEL_ID,
  ensureMainAgent,
  toProtocolMessage,
} from '@moonshot-ai/agent-core-v2';

import {
  buildWireMeta,
  COLD_SESSION_FACTS,
  toWireApproval,
  toWireConfig,
  toWireQuestion,
  toWireSession,
  toWireWorkspace,
  ulid,
  wireContentToPromptParts,
  type SessionFacts,
} from './builders.js';
import type {
  WireApprovalResponse,
  WireAuthResult,
  WireConfig,
  WireEnvelope,
  WireFsHomeResult,
  WireGitStatusResult,
  WireGoalSnapshot,
  WireMessage,
  WireMeta,
  WireModel,
  WireOAuthCancelResult,
  WireOAuthLoginPollResult,
  WireOAuthLoginStartResult,
  WirePage,
  WirePromptSubmission,
  WireProviderRefreshResult,
  WireQuestionResponse,
  WireLogoutResult,
  WireSession,
  WireSessionSnapshot,
  WireSessionStatus,
  WireSessionWarning,
  WireSkillDescriptor,
  WireTaskListItem,
  WireWorkspace,
} from './wire.js';

const REQUEST_INVALID = 40001;
const SESSION_NOT_FOUND = 40401;
const WORKSPACE_NOT_FOUND = 40410;
const PROVIDER_NOT_FOUND = 40412;

/** Most-recent messages included in a snapshot page (mirrors kap-server). */
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

/** Static server version surfaced on `getMeta` (the sidecar carries no build version). */
const SERVER_VERSION = '0.1.0';

/** Reserved service name the sidecar intercepts (frozen contract E). */
export const PRODUCT_SERVICE = 'desktopProduct';

function ok<T>(data: T): WireEnvelope<T> {
  return { code: 0, msg: 'success', data, request_id: ulid('req_') };
}

/** Positional-arg context the host forwards from the call frame. */
export interface ProductCallContext {
  readonly sessionId?: string;
  readonly agentId?: string;
}

interface PromptRoute {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number | undefined;
}

export class ProductFacade {
  /** Synthesized prompt_id → engine turn coordinates (for abort by promptId). */
  private readonly promptRoutes = new Map<string, PromptRoute>();

  /** Per-process server identity minted once (mirrors kap-server's boot-time ULID). */
  private readonly serverId = ulid('srv_');
  private readonly startedAt = new Date().toISOString();
  /**
   * Stable snapshot epoch. The sidecar does not run kap-server's transcript seq
   * journal, and the desktop product transport subscribes via the product event
   * stream (not seq cursors), so a fixed per-process epoch + `as_of_seq: 0` is a
   * well-formed watermark for boot.
   */
  private readonly epoch = ulid('ep_');

  constructor(
    private readonly klient: Klient,
    private readonly scope: ScopeLike,
  ) {}

  /** Dispatch a `desktopProduct` method by name over a positional arg array. */
  async dispatch(method: string, args: readonly unknown[], ctx: ProductCallContext): Promise<WireEnvelope<unknown>> {
    switch (method) {
      case 'listSessions':
        return this.listSessions(args[0]);
      case 'createSession':
        return this.createSession(args[0]);
      case 'submitPrompt':
        return this.submitPrompt(this.argSessionId(args[0], ctx), args[1]);
      case 'abortPrompt':
        return this.abortPrompt(this.argSessionId(args[0], ctx), args[1]);
      case 'respondApproval':
        return this.respondApproval(this.argSessionId(args[0], ctx), args[1], args[2]);
      case 'respondQuestion':
        return this.respondQuestion(this.argSessionId(args[0], ctx), args[1], args[2]);
      // Slice 2 — read-only clean-boot methods (no-arg calls take []).
      case 'getAuth':
        return this.getAuth();
      case 'startOAuthLogin':
        return this.startOAuthLogin();
      case 'pollOAuthLogin':
        return this.pollOAuthLogin();
      case 'cancelOAuthLogin':
        return this.cancelOAuthLogin();
      case 'logout':
        return this.logout();
      case 'refreshOAuthProviderModels':
        return this.refreshOAuthProviderModels();
      case 'getHealth':
        return this.getHealth();
      case 'getMeta':
        return this.getMeta();
      case 'getConfig':
        return this.getConfig();
      case 'listWorkspaces':
        return this.listWorkspaces();
      case 'getFsHome':
        return this.getFsHome();
      case 'listModels':
        return this.listModels();
      case 'getSessionSnapshot':
        return this.getSessionSnapshot(this.argSessionId(args[0], ctx));
      // Slice A — session-level read methods.
      case 'getSessionStatus':
        return this.getSessionStatus(this.argSessionId(args[0], ctx));
      case 'getSessionGoal':
        return this.getSessionGoal(this.argSessionId(args[0], ctx));
      case 'getSessionWarnings':
        return this.getSessionWarnings(this.argSessionId(args[0], ctx));
      case 'listSkills':
        return this.listSkills(this.argSessionId(args[0], ctx));
      case 'listTasks':
        return this.listTasks(this.argSessionId(args[0], ctx), args[1]);
      case 'getGitStatus':
        return this.getGitStatus(this.argSessionId(args[0], ctx), args[1]);
      // Slice C — write methods.
      case 'updateSession':
        return this.updateSession(this.argSessionId(args[0], ctx), args[1]);
      case 'setConfig':
        return this.setConfig(args[0]);
      case 'archiveSession':
        return this.archiveSession(this.argSessionId(args[0], ctx));
      case 'restoreSession':
        return this.restoreSession(this.argSessionId(args[0], ctx));
      case 'deleteSession':
        return this.deleteSession(this.argSessionId(args[0], ctx));
      case 'deleteWorkspace':
        return this.deleteWorkspace(args[0]);
      // Slice B — provider/model methods.
      case 'listProviders':
        return this.listProviders();
      case 'getProvider':
        return this.getProvider(args[0]);
      case 'createProvider':
        return this.createProvider(args[0]);
      case 'deleteProvider':
        return this.deleteProvider(args[0]);
      case 'setDefaultModel':
        return this.setDefaultModel(args[0]);
      default:
        throw new RPCError(REQUEST_INVALID, `unknown product method: ${method}`);
    }
  }

  private argSessionId(value: unknown, ctx: ProductCallContext): string {
    if (typeof value === 'string' && value.length > 0) return value;
    if (ctx.sessionId !== undefined) return ctx.sessionId;
    throw new RPCError(REQUEST_INVALID, 'product call missing sessionId');
  }

  // ---------------------------------------------------------------------------
  // listSessions — GET /sessions → { items: WireSession[], has_more }
  // ---------------------------------------------------------------------------

  async listSessions(queryRaw: unknown): Promise<WireEnvelope<WirePage<WireSession>>> {
    const q = (queryRaw ?? {}) as Record<string, unknown>;
    const page = await this.klient.global.sessions.list({
      includeArchived: q['include_archive'] === true || q['archived_only'] === true,
      limit: typeof q['page_size'] === 'number' ? q['page_size'] : undefined,
      cursor: typeof q['before_id'] === 'string' ? q['before_id'] : undefined,
      workspaceIds: typeof q['workspace_id'] === 'string' ? [q['workspace_id']] : undefined,
    });
    const items = page.items.map((summary) =>
      toWireSession(summary, summary.cwd ?? '', this.resolveFacts(summary.id)),
    );
    return ok<WirePage<WireSession>>({ items, has_more: page.nextCursor !== undefined });
  }

  // ---------------------------------------------------------------------------
  // createSession — POST /sessions → WireSession. Mirrors kap-server's route
  // (routes/sessions.ts): cwd arrives as `metadata.cwd` (or `workspace_id`,
  // whose root wins and must equal `metadata.cwd` when both are sent), the
  // workspace is createOrTouch'd so its id lands on the wire `workspace_id`,
  // and `metadata.cwd` is dropped from the persisted custom metadata.
  // ---------------------------------------------------------------------------

  async createSession(inputRaw: unknown): Promise<WireEnvelope<WireSession>> {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const metadata = isRecord(input['metadata']) ? input['metadata'] : undefined;
    const callerCwd =
      typeof metadata?.['cwd'] === 'string' && metadata['cwd'].length > 0
        ? metadata['cwd']
        : undefined;
    const workspaceId =
      typeof input['workspace_id'] === 'string' && input['workspace_id'].length > 0
        ? input['workspace_id']
        : undefined;
    if (workspaceId === undefined && callerCwd === undefined) {
      throw new RPCError(REQUEST_INVALID, 'metadata.cwd: either workspace_id or metadata.cwd is required');
    }

    const registry = this.scope.accessor.get(IWorkspaceService);
    let workDir: string;
    if (workspaceId !== undefined) {
      const workspace = await registry.get(workspaceId);
      if (workspace === undefined) {
        throw new RPCError(WORKSPACE_NOT_FOUND, `workspace ${workspaceId} does not exist`);
      }
      if (callerCwd !== undefined && callerCwd !== workspace.root) {
        throw new RPCError(
          REQUEST_INVALID,
          `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
        );
      }
      workDir = workspace.root;
    } else {
      workDir = callerCwd as string;
    }

    // Register/touch the workspace so `metadata.cwd` is resolvable on read and
    // the wire session carries `workspace_id` (kap-server gap G3 closure).
    const touched = await registry.createOrTouch(workDir);
    const title = typeof input['title'] === 'string' ? input['title'] : undefined;
    const meta = await this.klient.global.sessions.create({
      workDir,
      title,
      metadata: customMetadataFromWire(metadata),
    });
    return ok(toWireSession({ ...meta, workspaceId: touched.id }, touched.root, COLD_SESSION_FACTS));
  }

  // ---------------------------------------------------------------------------
  // submitPrompt — POST /sessions/{id}/prompts → WirePromptSubmitResult
  // ---------------------------------------------------------------------------

  async submitPrompt(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<unknown>> {
    const input = (inputRaw ?? {}) as WirePromptSubmission;
    const agentId = input.agent_id ?? 'main';
    const parts = wireContentToPromptParts(input.content ?? []);
    if (parts.length === 0) {
      throw new RPCError(REQUEST_INVALID, 'prompt content is empty');
    }

    const agent = this.klient.session(sessionId).agent(agentId);
    // Per-prompt runtime controls (kap-server applies these before enqueue).
    // Best-effort: a failure here must not block the prompt itself.
    await this.applyPromptControls(agent, input);

    const launched = await agent.prompt({ input: parts });
    const promptId = ulid('pr_');
    const userMessageId = ulid('msg_');
    this.promptRoutes.set(promptId, { sessionId, agentId, turnId: launched?.turn_id });
    return ok({ prompt_id: promptId, user_message_id: userMessageId, status: 'running' as const });
  }

  private async applyPromptControls(agent: AgentHandle, input: WirePromptSubmission): Promise<void> {
    try {
      if (typeof input.model === 'string' && input.model.length > 0) {
        await agent.setModel(input.model);
      }
      if (input.permission_mode === 'manual' || input.permission_mode === 'auto' || input.permission_mode === 'yolo') {
        await agent.setPermission(input.permission_mode);
      }
      if (typeof input.thinking === 'string' && input.thinking.length > 0) {
        await agent.profile.setThinking(input.thinking);
      }
    } catch {
      // Non-fatal: defaults apply.
    }
  }

  // ---------------------------------------------------------------------------
  // abortPrompt — POST /sessions/{id}/prompts/{pid}:abort → { aborted }
  // ---------------------------------------------------------------------------

  async abortPrompt(sessionId: string, promptIdRaw: unknown): Promise<WireEnvelope<unknown>> {
    const promptId = typeof promptIdRaw === 'string' ? promptIdRaw : undefined;
    const route = promptId !== undefined ? this.promptRoutes.get(promptId) : undefined;
    const agentId = route?.agentId ?? 'main';
    await this.klient
      .session(sessionId)
      .agent(agentId)
      .cancel(route?.turnId !== undefined ? { turnId: route.turnId } : {});
    if (promptId !== undefined) this.promptRoutes.delete(promptId);
    return ok({ aborted: true });
  }

  // ---------------------------------------------------------------------------
  // respondApproval — POST /sessions/{id}/approvals/{aid} → { resolved, resolved_at }
  // ---------------------------------------------------------------------------

  async respondApproval(sessionId: string, approvalIdRaw: unknown, responseRaw: unknown): Promise<WireEnvelope<unknown>> {
    const approvalId = requireString(approvalIdRaw, 'approvalId');
    const response = (responseRaw ?? {}) as WireApprovalResponse;
    await this.klient.session(sessionId).approvals.decide(approvalId, {
      decision: response.decision,
      scope: response.scope,
      feedback: response.feedback,
      selectedLabel: response.selected_label,
    });
    return ok({ resolved: true, resolved_at: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------------
  // respondQuestion — POST /sessions/{id}/questions/{qid} → { resolved, resolved_at }
  // ---------------------------------------------------------------------------

  async respondQuestion(sessionId: string, questionIdRaw: unknown, responseRaw: unknown): Promise<WireEnvelope<unknown>> {
    const questionId = requireString(questionIdRaw, 'questionId');
    const response = (responseRaw ?? {}) as WireQuestionResponse;
    const session = this.klient.session(sessionId);
    const result = await this.toInProcessAnswers(session, questionId, response);
    const method = response.method === 'click' ? undefined : response.method;
    await session.questions.answer(questionId, method !== undefined ? { answers: result, method } : result);
    return ok({ resolved: true, resolved_at: new Date().toISOString() });
  }

  /**
   * Reverse kap-server's synthesized question ids (`q_<i>` / `opt_<i>_<j>`) back
   * to the in-process `QuestionAnswers` (keyed by question text, value = option
   * label / free text / `true`). Best-effort: falls back to raw option ids when
   * the pending request cannot be matched.
   */
  private async toInProcessAnswers(
    session: ReturnType<Klient['session']>,
    questionId: string,
    response: WireQuestionResponse,
  ): Promise<QuestionAnswers> {
    let pending;
    try {
      pending = await session.questions.list();
    } catch {
      pending = [];
    }
    const request = pending.find((r) => r.id === questionId) ?? pending[0];
    const answers: QuestionAnswers = {};
    for (const [qid, answer] of Object.entries(response.answers ?? {})) {
      const qi = Number(qid.startsWith('q_') ? qid.slice(2) : qid);
      const item = request?.questions[qi];
      const labelOf = (optionId: string): string => {
        const oi = Number(optionId.startsWith('opt_') ? optionId.split('_')[2] : optionId);
        return item?.options[oi]?.label ?? optionId;
      };
      const key = item?.question ?? qid;
      switch (answer.kind) {
        case 'single':
          answers[key] = labelOf(answer.option_id);
          break;
        case 'multi':
          answers[key] = answer.option_ids.map(labelOf).join(', ') || true;
          break;
        case 'other':
          answers[key] = answer.text;
          break;
        case 'multi_with_other':
          answers[key] = [...answer.option_ids.map(labelOf), answer.other_text].join(', ');
          break;
        case 'skipped':
          break;
      }
    }
    return answers;
  }

  // ---------------------------------------------------------------------------
  // Slice 2 — read-only clean-boot methods. Each returns the kap-server-compatible
  // WireEnvelope JSON (routes named in desktop-product.md §12.3), fulfilled via
  // the in-process klient facade, or the app-scope engine service where no klient
  // method fits (getAuth / getSessionSnapshot mirror the kap-server route logic).
  // ---------------------------------------------------------------------------

  // getAuth — GET /auth → WireAuthResult (IAuthLegacyService.get() projection).
  async getAuth(): Promise<WireEnvelope<WireAuthResult>> {
    const summary = await this.scope.accessor.get(IAuthLegacyService).get();
    return ok<WireAuthResult>(summary);
  }

  async startOAuthLogin(): Promise<WireEnvelope<WireOAuthLoginStartResult>> {
    const result = await this.klient.global.auth.startLogin();
    return ok<WireOAuthLoginStartResult>(result);
  }

  async pollOAuthLogin(): Promise<WireEnvelope<WireOAuthLoginPollResult | null>> {
    const result = await this.klient.global.auth.flow();
    if (result === undefined) return ok<WireOAuthLoginPollResult | null>(null);
    return ok<WireOAuthLoginPollResult>({
      flow_id: result.flow_id,
      status: result.status === 'denied' ? 'expired' : result.status,
      resolved_at: result.resolved_at,
    });
  }

  async cancelOAuthLogin(): Promise<WireEnvelope<WireOAuthCancelResult>> {
    const result = await this.klient.global.auth.cancelLogin();
    return ok<WireOAuthCancelResult>(result);
  }

  async logout(): Promise<WireEnvelope<WireLogoutResult>> {
    const result = await this.klient.global.auth.logout();
    return ok<WireLogoutResult>(result);
  }

  async refreshOAuthProviderModels(): Promise<WireEnvelope<WireProviderRefreshResult>> {
    const result = await this.klient.global.kosong.refreshProviders({ scope: 'oauth' });
    return ok<WireProviderRefreshResult>(result);
  }

  // getHealth — GET /healthz → static { ok: true }.
  async getHealth(): Promise<WireEnvelope<{ ok: boolean }>> {
    return ok({ ok: true });
  }

  // getMeta — GET /meta → static WireMeta (backend: 'v2').
  async getMeta(): Promise<WireEnvelope<WireMeta>> {
    return ok(buildWireMeta(this.serverId, this.startedAt, SERVER_VERSION));
  }

  // getConfig — GET /config → WireConfig (IConfigService.getAll(), secrets redacted).
  async getConfig(): Promise<WireEnvelope<WireConfig>> {
    await this.scope.accessor.get(IConfigService).ready;
    const resolved = await this.klient.global.config.getAll();
    return ok<WireConfig>(toWireConfig(resolved));
  }

  // listWorkspaces — GET /workspaces → { items: WireWorkspace[] } (+ session_count).
  async listWorkspaces(): Promise<WireEnvelope<{ items: WireWorkspace[] }>> {
    const workspaces = await this.klient.global.workspaces.list();
    const wsSessions = this.scope.accessor.get(IWorkspaceSessions);
    const items = await Promise.all(
      workspaces.map(async (ws) => toWireWorkspace(ws, await wsSessions.count(ws.id))),
    );
    return ok({ items });
  }

  // getFsHome — GET /fs:home → WireFsHomeResult (IHostFolderBrowser.home()).
  async getFsHome(): Promise<WireEnvelope<WireFsHomeResult>> {
    const data = await this.klient.global.hostFs.home();
    return ok<WireFsHomeResult>(data);
  }

  // listModels — GET /models → { items: WireModel[] } (secondary-derived filtered).
  async listModels(): Promise<WireEnvelope<{ items: WireModel[] }>> {
    await this.scope.accessor.get(IConfigService).ready;
    const items = await this.klient.global.kosong.listModels();
    const models = items.filter((item) => item.model !== SECONDARY_DERIVED_MODEL_ID);
    return ok<{ items: WireModel[] }>({ items: models });
  }

  // getSessionSnapshot — GET /sessions/{id}/snapshot → WireSessionSnapshot.
  // Mirrors kap-server `readViaLegacyAssembly` (routes/snapshot.ts): resume the
  // session, project the wire session + the main agent's most-recent message
  // page + pending interactions through the same builders. The broadcaster-sourced
  // watermark / in-flight turn / subagents resolve to the boot defaults (seq 0, a
  // stable epoch, no in-flight turn) — the desktop product transport subscribes
  // via the product event stream, not the seq-cursor protocol.
  async getSessionSnapshot(sessionId: string): Promise<WireEnvelope<WireSessionSnapshot>> {
    const handle = await this.scope.accessor.get(ISessionLifecycleService).resume(sessionId);
    if (handle === undefined) {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} not found`);
    }

    // Session wire shape (the workspace root supplies `metadata.cwd`).
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    const workspace = await this.scope.accessor.get(IWorkspaceService).get(workspaceId);
    const cwd = workspace?.root ?? '';
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const session = toWireSession({ ...meta, workspaceId }, cwd, this.resolveFacts(sessionId));

    // Messages — most recent page of the main agent's live history.
    const main = handle.accessor.get(IAgentLifecycleService).get('main');
    let items: WireMessage[] = [];
    let hasMore = false;
    if (main !== undefined) {
      const history = main.accessor.get(IAgentContextMemoryService).get();
      hasMore = history.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
      const page = history.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);
      const offset = history.length - page.length;
      items = page.map((msg, i) =>
        toProtocolMessage(sessionId, offset + i, msg, meta.createdAt),
      ) as unknown as WireMessage[];
    }

    // Pending approvals / questions.
    const interaction = handle.accessor.get(ISessionInteractionService);
    const pendingApprovals = interaction
      .listPending('approval')
      .map((i) => toWireApproval(i, sessionId));
    const pendingQuestions = interaction
      .listPending('question')
      .map((i) => toWireQuestion(i, sessionId));

    return ok<WireSessionSnapshot>({
      as_of_seq: 0,
      epoch: this.epoch,
      session,
      messages: { items, has_more: hasMore },
      in_flight_turn: null,
      pending_approvals: pendingApprovals,
      pending_questions: pendingQuestions,
    });
  }

  // ---------------------------------------------------------------------------
  // session work facts (kap-server resolveSessionFacts)
  // ---------------------------------------------------------------------------

  private resolveFacts(sessionId: string): SessionFacts {
    const handle = this.scope.accessor.get(ISessionLifecycleService).get(sessionId);
    if (handle === undefined) return COLD_SESSION_FACTS;
    return handle.accessor.get(ISessionActivityView).state();
  }

  // ---------------------------------------------------------------------------
  // Slice A — session-level read methods. Each mirrors the corresponding
  // kap-server route, fulfilled via the in-process klient facade or the
  // app/session/agent-scope engine service (exactly as the route does).
  // ---------------------------------------------------------------------------

  private async resumeSession(sessionId: string) {
    const handle = await this.scope.accessor.get(ISessionLifecycleService).resume(sessionId);
    if (handle === undefined) {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} not found`);
    }
    return handle;
  }

  // getSessionStatus — GET /sessions/{id}/status → WireSessionStatus.
  async getSessionStatus(sessionId: string): Promise<WireEnvelope<WireSessionStatus>> {
    try {
      const status = await this.scope.accessor.get(ISessionLegacyService).status(sessionId);
      return ok<WireSessionStatus>(status);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  // getSessionGoal — GET /sessions/{id}/goal → WireGoalSnapshot | null (camelCase).
  async getSessionGoal(sessionId: string): Promise<WireEnvelope<WireGoalSnapshot | null>> {
    try {
      const goal = await this.scope.accessor.get(ISessionLegacyService).goal(sessionId);
      return ok<WireGoalSnapshot | null>(goal);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  // getSessionWarnings — GET /sessions/{id}/warnings → { warnings: [...] }.
  async getSessionWarnings(sessionId: string): Promise<WireEnvelope<{ warnings: WireSessionWarning[] }>> {
    const handle = await this.resumeSession(sessionId);
    const agent = await ensureMainAgent(handle);
    const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
    const secondaryModelWarning = handle.accessor
      .get(ISessionSecondaryModelWarningService)
      .getSecondaryModelWarning();
    const warnings: WireSessionWarning[] = [];
    if (agentsMdWarning !== undefined) {
      warnings.push({ code: 'agents-md-oversized', message: agentsMdWarning, severity: 'warning' });
    }
    if (secondaryModelWarning !== undefined) {
      warnings.push({
        code: secondaryModelWarning.code,
        message: secondaryModelWarning.message,
        severity: 'warning',
      });
    }
    return ok<{ warnings: WireSessionWarning[] }>({ warnings });
  }

  // listSkills — GET /sessions/{id}/skills → { skills: WireSkillDescriptor[] }.
  async listSkills(sessionId: string): Promise<WireEnvelope<{ skills: WireSkillDescriptor[] }>> {
    const handle = await this.resumeSession(sessionId);
    const skills = await handle.accessor.get(ISessionSkillCatalog).listSkills();
    return ok<{ skills: WireSkillDescriptor[] }>({
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        path: s.path,
        source: s.source,
        ...(s.type !== undefined ? { type: s.type } : {}),
        ...(s.disableModelInvocation !== undefined
          ? { disable_model_invocation: s.disableModelInvocation }
          : {}),
      })),
    });
  }

  // listTasks — GET /sessions/{id}/tasks → { items: WireTaskListItem[] }.
  async listTasks(
    sessionId: string,
    statusFilterRaw?: unknown,
  ): Promise<WireEnvelope<{ items: WireTaskListItem[] }>> {
    const handle = await this.resumeSession(sessionId);
    const agent = await ensureMainAgent(handle);
    const taskService = agent.accessor.get(IAgentTaskService);
    const all = taskService.list(false);
    let items = all.map((info) => toWireTaskListItem(info, sessionId));
    const statusFilter =
      typeof statusFilterRaw === 'string' ? statusFilterRaw : undefined;
    if (statusFilter !== undefined) {
      items = items.filter((t) => t.status === statusFilter);
    }
    return ok<{ items: WireTaskListItem[] }>({ items });
  }

  // getGitStatus — POST /sessions/{id}/fs:git_status → WireGitStatusResult.
  async getGitStatus(
    sessionId: string,
    pathsRaw?: unknown,
  ): Promise<WireEnvelope<WireGitStatusResult>> {
    const handle = await this.resumeSession(sessionId);
    const fs = handle.accessor.get(ISessionFsService);
    const paths =
      Array.isArray(pathsRaw) ? pathsRaw.filter((p): p is string => typeof p === 'string') : undefined;
    const result = await fs.gitStatus(paths !== undefined && paths.length > 0 ? { paths } : {});
    return ok<WireGitStatusResult>(result);
  }

  // ---------------------------------------------------------------------------
  // Slice C — write methods. Each mirrors the kap-server route, fulfilled via
  // the in-process klient facade or the app/session-scope engine service.
  // ---------------------------------------------------------------------------

  // updateSession — POST /sessions/{id}/profile → WireSession.
  // Mirrors kap-server: delegates to ISessionLegacyService.updateProfile, then
  // projects the result through toWireSession with live session facts.
  async updateSession(sessionId: string, bodyRaw: unknown): Promise<WireEnvelope<WireSession>> {
    try {
      const body = (bodyRaw ?? {}) as Record<string, unknown>;
      const fields = await this.scope.accessor
        .get(ISessionLegacyService)
        .updateProfile(sessionId, body as Parameters<ISessionLegacyService['updateProfile']>[1]);
      const session = toWireSession(
        { ...fields, workspaceId: fields.workspaceId },
        fields.root,
        this.resolveFacts(sessionId),
      );
      return ok(session);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  // setConfig — POST /config → WireConfig. Mirrors kap-server: convert keys
  // snake→camel, fold yolo, set per-domain, return full redacted config.
  async setConfig(patchRaw: unknown): Promise<WireEnvelope<WireConfig>> {
    const config = this.scope.accessor.get(IConfigService);
    await config.ready;
    const patch = (patchRaw ?? {}) as Record<string, unknown>;
    const camelPatch = convertKeysSnakeToCamel(patch) as Record<string, unknown>;
    // v1 wire sugar: `yolo: true` is an alias for `defaultPermissionMode = 'yolo'`.
    if (camelPatch['yolo'] === true) {
      camelPatch['defaultPermissionMode'] = 'yolo';
    }
    delete camelPatch['yolo'];
    for (const domain of Object.keys(camelPatch)) {
      await config.set(domain, camelPatch[domain]);
    }
    const resolved = await this.klient.global.config.getAll();
    return ok<WireConfig>(toWireConfig(resolved));
  }

  // archiveSession — POST /sessions/{id}:archive → { archived: true }.
  async archiveSession(sessionId: string): Promise<WireEnvelope<{ archived: boolean }>> {
    try {
      const lifecycle = this.scope.accessor.get(ISessionLifecycleService);
      // resume so archiving a cold session works; 40401 if unknown.
      const handle = await lifecycle.resume(sessionId);
      if (handle === undefined) {
        throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} not found`);
      }
      await lifecycle.archive(sessionId);
      return ok({ archived: true });
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  // restoreSession — POST /sessions/{id}:restore → WireSession (full session).
  async restoreSession(sessionId: string): Promise<WireEnvelope<WireSession>> {
    try {
      const lifecycle = this.scope.accessor.get(ISessionLifecycleService);
      const handle = await lifecycle.restore(sessionId);
      if (handle === undefined) {
        throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} not found`);
      }
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const workspace = await this.scope.accessor.get(IWorkspaceService).get(workspaceId);
      const cwd = workspace?.root ?? '';
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const session = toWireSession({ ...meta, workspaceId }, cwd, this.resolveFacts(sessionId));
      return ok(session);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  // deleteSession — no REST equivalent; klient-only sessionLifecycleService.delete.
  async deleteSession(sessionId: string): Promise<WireEnvelope<{ deleted: boolean }>> {
    const lifecycle = this.scope.accessor.get(ISessionLifecycleService);
    const handle = await lifecycle.resume(sessionId);
    if (handle === undefined) {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} not found`);
    }
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    await lifecycle.delete({ sessionId, workspaceId });
    return ok({ deleted: true });
  }

  // deleteWorkspace — DELETE /workspaces/{id} → { deleted: true }.
  async deleteWorkspace(idRaw: unknown): Promise<WireEnvelope<{ deleted: boolean }>> {
    const id = requireString(idRaw, 'workspaceId');
    const registry = this.scope.accessor.get(IWorkspaceService);
    const existing = await registry.get(id);
    if (existing === undefined) {
      throw new RPCError(WORKSPACE_NOT_FOUND, `workspace ${id} does not exist`);
    }
    await registry.delete(id);
    return ok({ deleted: true });
  }

  // ---------------------------------------------------------------------------
  // Slice B — provider/model methods. The klient facade's kosong surface
  // returns ProviderCatalogItem / SetDefaultModelResponse already in the wire
  // shape (snake_case), so these are thin pass-throughs. createProvider maps
  // the web client's AppProviderInput to the klient's ProviderInput.
  // ---------------------------------------------------------------------------

  // listProviders — GET /providers → { items: ProviderCatalogItem[] }.
  async listProviders(): Promise<WireEnvelope<{ items: unknown[] }>> {
    const items = await this.klient.global.kosong.listProviders();
    return ok<{ items: unknown[] }>({ items: [...items] });
  }

  // getProvider — GET /providers/{id} → ProviderCatalogItem (+ api_key from config).
  async getProvider(idRaw: unknown): Promise<WireEnvelope<Record<string, unknown>>> {
    const id = requireString(idRaw, 'providerId');
    const provider = await this.klient.global.kosong.getProvider(id);
    // Reveal the stored api_key for edit prefill (mirrors kap-server GET /providers/{id}).
    await this.scope.accessor.get(IConfigService).ready;
    const providers = this.scope.accessor.get(IConfigService).get<Record<string, { apiKey?: string }>>('providers');
    const apiKey = providers?.[id]?.apiKey;
    const result =
      apiKey !== undefined && apiKey !== ''
        ? { ...provider, api_key: apiKey }
        : { ...provider };
    return ok<Record<string, unknown>>(result);
  }

  // createProvider — POST /providers → ProviderCatalogItem.
  // Maps the web client's wire body to the klient's ProviderInput.
  async createProvider(inputRaw: unknown): Promise<WireEnvelope<Record<string, unknown>>> {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const id = requireString(input['id'], 'provider id');
    const type = typeof input['type'] === 'string' ? input['type'] : '';
    const apiKey = typeof input['api_key'] === 'string' ? input['api_key'] : '';
    const baseUrl = typeof input['base_url'] === 'string' ? input['base_url'] : undefined;
    const defaultModel =
      typeof input['default_model'] === 'string' && input['default_model'].length > 0
        ? `${id}/${input['default_model']}`
        : undefined;

    await this.klient.global.kosong.addProvider(id, {
      type,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      auth: { method: 'api-key', apiKey },
      ...(defaultModel !== undefined ? { defaultModel } : {}),
    });

    // Seed the global default model if models were provided and no default is set.
    const models = Array.isArray(input['models']) ? input['models'] as Array<Record<string, unknown>> : [];
    if (models.length > 0) {
      const config = this.scope.accessor.get(IConfigService);
      await config.ready;
      const current = config.inspect<string>('defaultModel').userValue;
      if (current === undefined || current.trim() === '') {
        const firstModelName = typeof models[0]?.['model'] === 'string' ? models[0]['model'] as string : '';
        if (firstModelName.length > 0) {
          await this.klient.global.kosong.setDefaultModel(`${id}/${firstModelName}`);
        }
      }
    }

    const provider = await this.klient.global.kosong.getProvider(id);
    return ok<Record<string, unknown>>({ ...provider });
  }

  // deleteProvider — DELETE /providers/{id} → { deleted: true }.
  async deleteProvider(idRaw: unknown): Promise<WireEnvelope<{ deleted: boolean }>> {
    const id = requireString(idRaw, 'providerId');
    // Check existence first (kap-server returns 40412 PROVIDER_NOT_FOUND).
    try {
      await this.klient.global.kosong.getProvider(id);
    } catch {
      throw new RPCError(PROVIDER_NOT_FOUND, `provider ${id} does not exist`);
    }
    await this.klient.global.kosong.removeProvider(id);
    return ok({ deleted: true });
  }

  // setDefaultModel — POST /models/{id}:set_default → SetDefaultModelResponse.
  async setDefaultModel(idRaw: unknown): Promise<WireEnvelope<Record<string, unknown>>> {
    const id = requireString(idRaw, 'modelId');
    const result = await this.klient.global.kosong.setDefaultModel(id);
    return ok<Record<string, unknown>>({ ...result });
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RPCError(REQUEST_INVALID, `product call missing ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors kap-server `toWireTask` (routes/tasks.ts): project the engine
 *  `AgentTaskInfo` (camelCase + ms timestamps) to the wire `Task` (snake_case
 *  + ISO timestamps), collapsing the engine-only status/kind literals. */
function toWireTaskListItem(
  info: {
    readonly taskId: string;
    readonly kind: string;
    readonly description: string;
    readonly status: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly command?: string;
  },
  sessionId: string,
): WireTaskListItem {
  const mapKind = (k: string): WireTaskListItem['kind'] => {
    switch (k) {
      case 'process': return 'bash';
      case 'agent': return 'subagent';
      default: return 'tool';
    }
  };
  const mapStatus = (s: string): WireTaskListItem['status'] => {
    switch (s) {
      case 'running': return 'running';
      case 'completed': return 'completed';
      case 'failed':
      case 'timed_out':
      case 'lost': return 'failed';
      case 'killed': return 'cancelled';
      default: return 'failed';
    }
  };
  const createdIso = new Date(info.startedAt).toISOString();
  const item: WireTaskListItem = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status: mapStatus(info.status),
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    item.completed_at = new Date(info.endedAt).toISOString();
  }
  if (info.kind === 'process' && info.command !== undefined) {
    item.command = info.command;
  }
  return item;
}

/** Mirrors kap-server `customMetadataFromWire`: drop `cwd` from the persisted
 *  custom metadata (the workspace registry is the cwd source of truth). */
function customMetadataFromWire(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const { cwd: _drop, ...custom } = metadata;
  return Object.keys(custom).length === 0 ? undefined : custom;
}

/**
 * Mirror kap-server's `sendMappedError`: translate engine `Error2` codes to the
 * wire error codes the daemon HTTP transport returns. Only the codes the slice-A
 * methods can throw are mapped; anything else passes through as a generic 50001.
 */
function mapEngineError(error: unknown): RPCError {
  if (isError2(error)) {
    switch (error.code) {
      case 'session.not_found':
      case 'agent.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      default:
        break;
    }
  }
  throw error;
}

/** Mirrors kap-server `convertKeysSnakeToCamel` (routes/config.ts). */
function convertKeysSnakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(convertKeysSnakeToCamel);
  if (isRecord(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[snakeToCamel(key)] = convertKeysSnakeToCamel(value);
    }
    return result;
  }
  return obj;
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
