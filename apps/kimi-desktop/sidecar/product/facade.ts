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
import { isAbsolute } from 'node:path';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';
import {
  ISessionLegacyService,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionLegacy';
import { ISessionActivityView } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionActivity';
import type { QuestionAnswers } from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  FsDiffResponse,
  FsGrepResponse,
  FsListResponse,
  FsReadResponse,
  FsSearchResponse,
} from '@moonshot-ai/agent-core-v2/session/sessionFs/fs';
import {
  fsDiffRequestSchema,
  fsGrepRequestSchema,
  fsListRequestSchema,
  fsReadRequestSchema,
  fsSearchRequestSchema,
} from '@moonshot-ai/agent-core-v2/session/sessionFs/fs';
import { Error2, isError2 } from '@moonshot-ai/agent-core-v2/_base/errors/errors';
import {
  IAgentContextMemoryService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentRPCService,
  IAgentTaskService,
  IAuthLegacyService,
  IAuthSummaryService,
  IConfigService,
  IEventService,
  IHostFileSystem,
  IHostFolderBrowser,
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IKosongConfigService,
  IMessageLegacyService,
  IModelCatalog,
  PROVIDER_ID_PATTERN,
  ISessionBtwService,
  ISessionContext,
  ISessionExpertTeamService,
  ISessionFsService,
  ISessionIndex,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionQuestionService,
  ISessionSecondaryModelWarningService,
  ISessionSkillCatalog,
  IWorkspaceService,
  IWorkspaceSessions,
  SECONDARY_DERIVED_MODEL_ID,
  ensureMainAgent,
  toProtocolMessage,
} from '@moonshot-ai/agent-core-v2';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import type {
  ModelRecord,
  ModelsSection,
} from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type {
  ProviderConfig,
  ProvidersSection,
} from '@moonshot-ai/agent-core-v2/kosong/provider/provider';

import {
  buildWireMeta,
  COLD_SESSION_FACTS,
  toWireApproval,
  toWireConfig,
  toWireExpertTeamDefinition,
  toWireExpertTeamSnapshot,
  toWireQuestion,
  toWireSession,
  toWireTask,
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
  WireExpertTeamDefinition,
  WireExpertTeamSnapshot,
  WireFsBrowseResult,
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
import type { ProductStreamHub } from './stream.js';
import {
  launchDetached,
  openFileCommandFor,
  openInAppCommandFor,
  OPEN_IN_APP_IDS,
  revealFileCommandFor,
  type OpenInAppId,
} from './fileLaunch.js';

const REQUEST_INVALID = 40001;
const REQUEST_MALFORMED = 40002;
const SESSION_NOT_FOUND = 40401;
const PROMPT_NOT_FOUND = 40402;
const QUESTION_NOT_FOUND = 40405;
const TASK_NOT_FOUND = 40406;
const FS_PATH_NOT_FOUND = 40409;
const WORKSPACE_NOT_FOUND = 40410;
const FS_PERMISSION_DENIED = 40411;
const PROVIDER_NOT_FOUND = 40412;
const SESSION_BUSY = 40901;
const APPROVAL_ALREADY_RESOLVED = 40902;
const TASK_ALREADY_FINISHED = 40904;
const FS_IS_DIRECTORY = 40906;
const FS_IS_BINARY = 40907;
const FS_GIT_UNAVAILABLE = 40908;
const QUESTION_DISMISSED = 40909;
const COMPACTION_UNABLE = 40910;
const SESSION_UNDO_UNAVAILABLE = 40911;
const FS_ALREADY_EXISTS = 40919;
const FS_TOO_LARGE = 41302;
const FS_TOO_MANY_RESULTS = 41303;
const FS_PATH_ESCAPES_SESSION = 41304;
const FS_GREP_TIMEOUT = 41305;
const INTERNAL_ERROR = 50001;

/** Default cap (bytes) for getTask output preview — mirrors kap-server. */
const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

/** v1 `:undo` message page-size clamp. */
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

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
   * Stable snapshot epoch fallback. Used only when no stream hub is wired (e.g.
   * a unit test constructs the facade directly); with a hub, the snapshot reads
   * the hub's per-(session, agent) watermark so snapshot + subscription share a
   * cursor space (docs/plan/desktop-v2-full-integration.md, event consistency).
   */
  private readonly epoch = ulid('ep_');
  /** Serialize multi-section provider edits so concurrent saves cannot interleave. */
  private providerWriteChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly klient: Klient,
    private readonly scope: ScopeLike,
    /** The stream hub whose watermark backs getSessionSnapshot. Optional so the
     *  facade stays constructible without the event layer (tests). */
    private readonly streamHub?: ProductStreamHub,
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
      // Slice 1 — obvious breakpoints (expert teams + session/history/task gaps).
      case 'listExpertTeams':
        return this.listExpertTeams(this.argSessionId(args[0], ctx));
      case 'getExpertTeam':
        return this.getExpertTeam(this.argSessionId(args[0], ctx));
      case 'activateExpertTeam':
        return this.activateExpertTeam(this.argSessionId(args[0], ctx), args[1]);
      case 'deactivateExpertTeam':
        return this.deactivateExpertTeam(this.argSessionId(args[0], ctx));
      case 'getSession':
        return this.getSession(this.argSessionId(args[0], ctx));
      case 'listMessages':
        return this.listMessages(this.argSessionId(args[0], ctx), args[1]);
      case 'dismissQuestion':
        return this.dismissQuestion(this.argSessionId(args[0], ctx), args[1]);
      case 'getTask':
        return this.getTask(this.argSessionId(args[0], ctx), args[1], args[2]);
      case 'cancelTask':
        return this.cancelTask(this.argSessionId(args[0], ctx), args[1]);
      // Slice 2 — session control.
      case 'steerPrompts':
        return this.steerPrompts(this.argSessionId(args[0], ctx), args[1]);
      case 'abortSession':
        return this.abortSession(this.argSessionId(args[0], ctx));
      case 'compactSession':
        return this.compactSession(this.argSessionId(args[0], ctx), args[1]);
      case 'undoSession':
        return this.undoSession(this.argSessionId(args[0], ctx), args[1]);
      case 'forkSession':
        return this.forkSession(this.argSessionId(args[0], ctx), args[1]);
      case 'createChildSession':
        return this.createChildSession(this.argSessionId(args[0], ctx), args[1]);
      case 'listChildSessions':
        return this.listChildSessions(this.argSessionId(args[0], ctx), args[1]);
      case 'startBtw':
        return this.startBtw(this.argSessionId(args[0], ctx));
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
      case 'addWorkspace':
        return this.addWorkspace(args[0]);
      case 'updateWorkspace':
        return this.updateWorkspace(args[0], args[1]);
      case 'browseFs':
        return this.browseFs(args[0]);
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
      // Slice 4 — workspace + structured filesystem (P1).
      case 'listDirectory':
        return this.listDirectory(this.argSessionId(args[0], ctx), args[1]);
      case 'readFile':
        return this.readFile(this.argSessionId(args[0], ctx), args[1]);
      case 'searchFiles':
        return this.searchFiles(this.argSessionId(args[0], ctx), args[1]);
      case 'grepFiles':
        return this.grepFiles(this.argSessionId(args[0], ctx), args[1]);
      case 'getFileDiff':
        return this.getFileDiff(this.argSessionId(args[0], ctx), args[1]);
      case 'openFile':
        return this.openFile(this.argSessionId(args[0], ctx), args[1]);
      case 'revealFile':
        return this.revealFile(this.argSessionId(args[0], ctx), args[1]);
      case 'openInApp':
        return this.openInApp(this.argSessionId(args[0], ctx), args[1], args[2], args[3]);
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
      case 'replaceProvider':
        return this.replaceProvider(args[0], args[1]);
      case 'deleteProvider':
        return this.deleteProvider(args[0]);
      case 'refreshProvider':
        return this.refreshProvider(args[0]);
      case 'refreshAllProviders':
        return this.refreshAllProviders();
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
  // Slice 1 — obvious breakpoints. Mirror kap-server routes/expertTeams.ts,
  // sessions.ts (GET by id), messages.ts, questions.ts (:dismiss), tasks.ts.
  // ---------------------------------------------------------------------------

  async listExpertTeams(
    sessionId: string,
  ): Promise<WireEnvelope<{ experts: WireExpertTeamDefinition[] }>> {
    const handle = await this.resumeSession(sessionId);
    const experts = await handle.accessor.get(ISessionExpertTeamService).listAvailable();
    return ok({ experts: experts.map(toWireExpertTeamDefinition) });
  }

  async getExpertTeam(
    sessionId: string,
  ): Promise<WireEnvelope<{ expert_team: WireExpertTeamSnapshot | null }>> {
    const handle = await this.resumeSession(sessionId);
    const snapshot = handle.accessor.get(ISessionExpertTeamService).snapshot();
    return ok({
      expert_team: snapshot === null ? null : toWireExpertTeamSnapshot(snapshot),
    });
  }

  async activateExpertTeam(
    sessionId: string,
    bodyRaw: unknown,
  ): Promise<WireEnvelope<{ expert_team: WireExpertTeamSnapshot }>> {
    const pluginId = requireString(
      isRecord(bodyRaw) ? bodyRaw['plugin_id'] : undefined,
      'plugin_id',
    );
    const handle = await this.resumeSession(sessionId);
    try {
      const snapshot = await handle.accessor.get(ISessionExpertTeamService).activate(pluginId);
      return ok({ expert_team: toWireExpertTeamSnapshot(snapshot) });
    } catch (error) {
      if (error instanceof Error2) {
        throw new RPCError(REQUEST_MALFORMED, error.message);
      }
      throw error;
    }
  }

  async deactivateExpertTeam(
    sessionId: string,
  ): Promise<WireEnvelope<{ deactivated: true }>> {
    const handle = await this.resumeSession(sessionId);
    try {
      await handle.accessor.get(ISessionExpertTeamService).deactivate();
      return ok({ deactivated: true as const });
    } catch (error) {
      if (error instanceof Error2) {
        throw new RPCError(REQUEST_MALFORMED, error.message);
      }
      throw error;
    }
  }

  /** GET /sessions/{id} — ISessionIndex only (no resume), mirrors kap-server. */
  async getSession(sessionId: string): Promise<WireEnvelope<WireSession>> {
    const summary = await this.scope.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const cwd =
      summary.cwd ??
      (await this.scope.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
    if (cwd === undefined) {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} has no recoverable cwd`);
    }
    return ok(toWireSession(summary, cwd, this.resolveFacts(sessionId)));
  }

  /** GET /sessions/{id}/messages — App-scope IMessageLegacyService (cold-readable). */
  async listMessages(
    sessionId: string,
    queryRaw: unknown,
  ): Promise<WireEnvelope<WirePage<WireMessage>>> {
    const q = (queryRaw ?? {}) as Record<string, unknown>;
    if (typeof q['before_id'] === 'string' && typeof q['after_id'] === 'string') {
      throw new RPCError(REQUEST_INVALID, 'before_id and after_id are mutually exclusive');
    }
    const query: {
      before_id?: string;
      after_id?: string;
      page_size?: number;
      role?: 'user' | 'assistant' | 'tool' | 'system';
    } = {
      before_id: typeof q['before_id'] === 'string' ? q['before_id'] : undefined,
      after_id: typeof q['after_id'] === 'string' ? q['after_id'] : undefined,
      page_size: typeof q['page_size'] === 'number' ? q['page_size'] : undefined,
      role:
        q['role'] === 'user' ||
        q['role'] === 'assistant' ||
        q['role'] === 'tool' ||
        q['role'] === 'system'
          ? q['role']
          : undefined,
    };
    try {
      const page = await this.scope.accessor.get(IMessageLegacyService).list(sessionId, query);
      return ok(page as WirePage<WireMessage>);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  /**
   * POST /sessions/{id}/questions/{qid}:dismiss — success is envelope code 40909
   * (question.dismissed), matching kap-server / the daemon allowCodes path.
   */
  async dismissQuestion(
    sessionId: string,
    questionIdRaw: unknown,
  ): Promise<WireEnvelope<unknown>> {
    const questionId = requireString(questionIdRaw, 'questionId');
    const handle = await this.resumeSession(sessionId);
    const interaction = handle.accessor.get(ISessionInteractionService);
    const pendingInteraction = interaction
      .listPending('question')
      .find((i) => i.id === questionId);

    if (pendingInteraction === undefined) {
      if (interaction.isRecentlyResolved(questionId)) {
        return {
          code: APPROVAL_ALREADY_RESOLVED,
          msg: `question ${questionId} already resolved`,
          data: { resolved: false as const },
          request_id: ulid('req_'),
        };
      }
      throw new RPCError(QUESTION_NOT_FOUND, `question ${questionId} not found`);
    }

    handle.accessor.get(ISessionQuestionService).dismiss(questionId);
    return {
      code: QUESTION_DISMISSED,
      msg: `question ${questionId} dismissed`,
      data: { dismissed: true as const, dismissed_at: new Date().toISOString() },
      request_id: ulid('req_'),
    };
  }

  /**
   * GET /sessions/{id}/tasks/{tid} — index existence + live lifecycle.get (no
   * resume), matching kap-server resolveSessionTasks.
   */
  async getTask(
    sessionId: string,
    taskIdRaw: unknown,
    queryRaw: unknown,
  ): Promise<WireEnvelope<WireTaskListItem>> {
    const taskId = requireString(taskIdRaw, 'taskId');
    const resolved = await this.resolveSessionTasks(sessionId);
    if (resolved.kind === 'not_found') {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const found = resolved.tasks?.getTask(taskId);
    if (found === undefined) {
      throw new RPCError(TASK_NOT_FOUND, `task ${taskId} does not exist in session ${sessionId}`);
    }

    const query = (queryRaw ?? {}) as Record<string, unknown>;
    let output: { preview: string; bytes: number } | undefined;
    if (query['with_output'] === true && resolved.tasks !== undefined) {
      const tailBytes =
        typeof query['output_bytes'] === 'number'
          ? query['output_bytes']
          : DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
      try {
        const preview = await resolved.tasks.readOutput(taskId, tailBytes);
        if (preview.length > 0) {
          output = { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
        }
      } catch {
        // Output may not be available yet; fall back to task metadata only.
      }
    }
    return ok(toWireTask(sessionId, found, output));
  }

  async cancelTask(
    sessionId: string,
    taskIdRaw: unknown,
  ): Promise<WireEnvelope<unknown>> {
    const taskId = requireString(taskIdRaw, 'taskId');
    const resolved = await this.resolveSessionTasks(sessionId);
    if (resolved.kind === 'not_found') {
      throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const found = resolved.tasks?.getTask(taskId);
    if (found === undefined) {
      throw new RPCError(TASK_NOT_FOUND, `task ${taskId} does not exist in session ${sessionId}`);
    }
    const wireStatus = toWireTask(sessionId, found).status;
    if (wireStatus === 'completed' || wireStatus === 'failed' || wireStatus === 'cancelled') {
      return {
        code: TASK_ALREADY_FINISHED,
        msg: `task ${taskId} already finished (status: ${wireStatus})`,
        data: { cancelled: false },
        request_id: ulid('req_'),
      };
    }
    await resolved.tasks?.stopByUser(taskId);
    return ok({ cancelled: true as const });
  }

  /**
   * Walk core → ISessionIndex → live ISessionLifecycleService.get → main agent
   * task service. Mirrors kap-server `resolveSessionTasks` (no resume).
   */
  private async resolveSessionTasks(
    sessionId: string,
  ): Promise<
    | { readonly kind: 'not_found' }
    | { readonly kind: 'resolved'; readonly tasks: IAgentTaskService | undefined }
  > {
    const summary = await this.scope.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return { kind: 'not_found' };
    const session = this.scope.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) return { kind: 'resolved', tasks: undefined };
    const agent = await ensureMainAgent(session);
    return { kind: 'resolved', tasks: agent.accessor.get(IAgentTaskService) };
  }

  // ---------------------------------------------------------------------------
  // Slice 2 — session control. Mirror kap-server prompts.ts + sessions.ts
  // action handlers (steer / abort / compact / undo / fork / children / btw).
  // ---------------------------------------------------------------------------

  async steerPrompts(
    sessionId: string,
    bodyRaw: unknown,
  ): Promise<WireEnvelope<{ steered: true; prompt_ids: string[] }>> {
    const body = isRecord(bodyRaw) ? bodyRaw : {};
    const promptIdsRaw = body['prompt_ids'];
    if (!Array.isArray(promptIdsRaw) || promptIdsRaw.some((id) => typeof id !== 'string')) {
      throw new RPCError(REQUEST_INVALID, 'prompt_ids must be a string array');
    }
    const promptIds = promptIdsRaw as string[];
    try {
      const handle = await this.resumeSession(sessionId);
      const agent = await ensureMainAgent(handle);
      await agent.accessor.get(IAgentPromptService).steer(promptIds);
      return ok({ steered: true as const, prompt_ids: [...promptIds] });
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async abortSession(sessionId: string): Promise<WireEnvelope<{ aborted: true }>> {
    try {
      const handle = await this.resumeSession(sessionId);
      const agent = await ensureMainAgent(handle);
      await agent.accessor.get(IAgentRPCService).cancel({});
      return ok({ aborted: true as const });
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async compactSession(
    sessionId: string,
    bodyRaw: unknown,
  ): Promise<WireEnvelope<Record<string, never>>> {
    try {
      const handle = await this.resumeSession(sessionId);
      const agent = await ensureMainAgent(handle);
      const instruction =
        isRecord(bodyRaw) && typeof bodyRaw['instruction'] === 'string'
          ? normalizeOptional(bodyRaw['instruction'])
          : undefined;
      // begin returns false when busy — kap-server treats that as silent success.
      agent.accessor
        .get(IAgentFullCompactionService)
        .begin({ source: 'manual', instruction });
      return ok({});
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async undoSession(
    sessionId: string,
    bodyRaw: unknown,
  ): Promise<WireEnvelope<{ messages: WirePage<WireMessage>; status: WireSessionStatus }>> {
    try {
      const handle = await this.resumeSession(sessionId);
      const agent = await ensureMainAgent(handle);
      const body = isRecord(bodyRaw) ? bodyRaw : {};
      const count = typeof body['count'] === 'number' && body['count'] > 0 ? body['count'] : 1;
      const pageSize =
        typeof body['page_size'] === 'number' ? body['page_size'] : undefined;
      await agent.accessor.get(IAgentConversationUndoService).undo(count);
      const history = agent.accessor.get(IAgentContextMemoryService).get();
      const [summary, status] = await Promise.all([
        this.scope.accessor.get(ISessionIndex).get(sessionId),
        this.scope.accessor.get(ISessionLegacyService).status(sessionId),
      ]);
      return ok({
        messages: pageUndoMessages(
          sessionId,
          summary?.createdAt ?? 0,
          history,
          pageSize,
        ),
        status,
      });
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async forkSession(
    sessionId: string,
    bodyRaw: unknown,
  ): Promise<WireEnvelope<WireSession>> {
    try {
      const body = isRecord(bodyRaw) ? bodyRaw : {};
      const title = typeof body['title'] === 'string' ? body['title'] : undefined;
      const metadata = isRecord(body['metadata']) ? body['metadata'] : undefined;
      const handle = await this.scope.accessor.get(ISessionLifecycleService).fork({
        sourceSessionId: sessionId,
        title,
        metadata,
      });
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const ctx = handle.accessor.get(ISessionContext);
      const session = toWireSession(
        { ...meta, workspaceId: ctx.workspaceId },
        ctx.cwd,
        this.resolveFacts(meta.id),
      );
      this.scope.accessor.get(IEventService).publish({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: session.id, session },
      });
      return ok(session);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async createChildSession(
    sessionId: string,
    bodyRaw: unknown,
  ): Promise<WireEnvelope<WireSession>> {
    try {
      const body = isRecord(bodyRaw) ? bodyRaw : {};
      const title = typeof body['title'] === 'string' ? body['title'] : undefined;
      const metadata = isRecord(body['metadata']) ? body['metadata'] : undefined;
      const handle = await this.scope.accessor.get(ISessionLifecycleService).createChild({
        sourceSessionId: sessionId,
        title,
        metadata,
      });
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const ctx = handle.accessor.get(ISessionContext);
      const session = toWireSession(
        { ...meta, workspaceId: ctx.workspaceId },
        ctx.cwd,
        this.resolveFacts(meta.id),
      );
      this.scope.accessor.get(IEventService).publish({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: session.id, session },
      });
      return ok(session);
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async listChildSessions(
    sessionId: string,
    queryRaw: unknown,
  ): Promise<WireEnvelope<WirePage<WireSession>>> {
    try {
      const exists =
        this.scope.accessor.get(ISessionLifecycleService).get(sessionId) !== undefined ||
        (await this.scope.accessor.get(ISessionIndex).get(sessionId)) !== undefined;
      if (!exists) {
        throw new RPCError(SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }
      const children = (await this.scope.accessor.get(ISessionIndex).list({ childOf: sessionId }))
        .items;
      const q = isRecord(queryRaw) ? queryRaw : {};
      let pivotIndex = -1;
      if (typeof q['before_id'] === 'string') {
        pivotIndex = children.findIndex((s) => s.id === q['before_id']);
      } else if (typeof q['after_id'] === 'string') {
        pivotIndex = children.findIndex((s) => s.id === q['after_id']);
      }
      let slice = children;
      if (typeof q['before_id'] === 'string' && pivotIndex >= 0) {
        slice = children.slice(pivotIndex + 1);
      } else if (typeof q['after_id'] === 'string' && pivotIndex >= 0) {
        slice = children.slice(0, pivotIndex);
      }
      const pageSize =
        typeof q['page_size'] === 'number' && q['page_size'] > 0
          ? Math.min(q['page_size'], 100)
          : 100;
      const window = slice.slice(0, pageSize);
      const roots = new Map(
        (await this.scope.accessor.get(IWorkspaceService).list()).map((w) => [w.id, w.root]),
      );
      const projected = window.map((summary) =>
        toWireSession(
          summary,
          summary.cwd ?? roots.get(summary.workspaceId) ?? '',
          this.resolveFacts(summary.id),
        ),
      );
      const busyFilter = typeof q['busy'] === 'boolean' ? q['busy'] : undefined;
      const items =
        busyFilter !== undefined
          ? projected.filter((session) => session.busy === busyFilter)
          : projected;
      return ok({ items, has_more: slice.length > pageSize });
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  async startBtw(sessionId: string): Promise<WireEnvelope<{ agent_id: string }>> {
    try {
      const handle = await this.resumeSession(sessionId);
      await this.scope.accessor.get(IAuthSummaryService).ensureReady();
      const agentId = await handle.accessor.get(ISessionBtwService).start();
      return ok({ agent_id: agentId });
    } catch (error) {
      throw mapEngineError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Earlier slices — read-only clean-boot methods. Each returns the kap-server-compatible
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

  // addWorkspace — POST /workspaces → WireWorkspace. Mirrors kap-server
  // (routes/workspaces.ts): the root must be an absolute path that exists and
  // is a directory (validated through IHostFileSystem, never raw Node fs), then
  // createOrTouch registers it idempotently and the wire shape carries the
  // derived session_count.
  async addWorkspace(inputRaw: unknown): Promise<WireEnvelope<WireWorkspace>> {
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const root = typeof input['root'] === 'string' ? input['root'] : '';
    const name = typeof input['name'] === 'string' ? input['name'] : undefined;
    if (!isAbsolute(root)) {
      throw new RPCError(REQUEST_INVALID, 'root must be an absolute path');
    }
    const hostFs = this.scope.accessor.get(IHostFileSystem);
    try {
      const stat = await hostFs.stat(root);
      if (!stat.isDirectory) {
        throw new RPCError(FS_PATH_NOT_FOUND, `root ${root} is not a directory`);
      }
    } catch (error) {
      if (error instanceof RPCError) throw error;
      throw new RPCError(FS_PATH_NOT_FOUND, `root ${root} does not exist`);
    }
    const registry = this.scope.accessor.get(IWorkspaceService);
    const ws = await registry.createOrTouch(root, name);
    const sessionCount = await this.scope.accessor.get(IWorkspaceSessions).count(ws.id);
    return ok(toWireWorkspace(ws, sessionCount));
  }

  // updateWorkspace — PATCH /workspaces/{id} → WireWorkspace. Renames the
  // display name only (never moves the on-disk directory); unknown id →
  // WORKSPACE_NOT_FOUND, matching kap-server.
  async updateWorkspace(idRaw: unknown, inputRaw: unknown): Promise<WireEnvelope<WireWorkspace>> {
    const id = requireString(idRaw, 'workspaceId');
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const name = requireString(input['name'], 'name');
    const registry = this.scope.accessor.get(IWorkspaceService);
    const ws = await registry.update(id, { name });
    if (ws === undefined) {
      throw new RPCError(WORKSPACE_NOT_FOUND, `workspace ${id} does not exist`);
    }
    const sessionCount = await this.scope.accessor.get(IWorkspaceSessions).count(ws.id);
    return ok(toWireWorkspace(ws, sessionCount));
  }

  // browseFs — GET /fs:browse → WireFsBrowseResult (IHostFolderBrowser.browse()).
  // HostFolder domain errors map onto the kap-server wire codes (validation /
  // path-not-found / permission-denied); the klient surface returns the wire
  // shape directly.
  async browseFs(pathRaw?: unknown): Promise<WireEnvelope<WireFsBrowseResult>> {
    const path = typeof pathRaw === 'string' && pathRaw.length > 0 ? pathRaw : undefined;
    try {
      const data = await this.klient.global.hostFs.browse(path);
      return ok<WireFsBrowseResult>(data);
    } catch (error) {
      throw mapBrowseError(error);
    }
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
  // page + pending interactions through the same builders. The watermark
  // (`as_of_seq` + `epoch`) is read from the stream hub so the subsequent
  // product subscription resumes from exactly this point; without a hub it
  // falls back to the boot default (seq 0, a stable per-process epoch).
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

    // Watermark shared with the product event stream: a snapshot taken now and
    // the subscription started next resume from the same (epoch, seq).
    const watermark = this.streamHub?.watermark(sessionId, 'main') ?? {
      epoch: this.epoch,
      asOfSeq: 0,
    };

    return ok<WireSessionSnapshot>({
      as_of_seq: watermark.asOfSeq,
      epoch: watermark.epoch,
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
    let items = all.map((info) => toWireTask(sessionId, info));
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
  // Slice 4 — structured session filesystem (P1). Each mirrors kap-server's
  // `fs:<action>` dispatcher (routes/fs.ts): cold-resume the session, resolve
  // the Session-scoped ISessionFsService, pass the snake_case request straight
  // through (the engine's zod defaults fill omitted fields), and return the
  // engine response — already the wire shape — wrapped in the envelope. Domain
  // Error2 codes map onto the kap-server wire codes via mapFsError. Relative
  // paths stay confined to the session workspace inside ISessionFsService.
  // ---------------------------------------------------------------------------

  // fs:list → WireListDirectoryResult (depth / git status / truncated preserved).
  async listDirectory(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<FsListResponse>> {
    const fs = await this.sessionFs(sessionId);
    try {
      const data = await fs.list(fsListRequestSchema.parse(inputRaw ?? {}));
      return ok(data);
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:read → WireReadFileResult (offset / length / binary / etag / mime / size).
  async readFile(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<FsReadResponse>> {
    const fs = await this.sessionFs(sessionId);
    try {
      const data = await fs.read(fsReadRequestSchema.parse(inputRaw ?? {}));
      return ok(data);
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:search → WireSearchFilesResult (limit / score / match positions).
  async searchFiles(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<FsSearchResponse>> {
    const fs = await this.sessionFs(sessionId);
    try {
      const data = await fs.search(fsSearchRequestSchema.parse(inputRaw ?? {}));
      return ok(data);
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:grep → WireGrepFilesResult (regex / case sensitivity / context lines).
  async grepFiles(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<FsGrepResponse>> {
    const fs = await this.sessionFs(sessionId);
    try {
      const data = await fs.grep(fsGrepRequestSchema.parse(inputRaw ?? {}));
      return ok(data);
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:diff → WireDiffResult (unified diff; git-unavailable preserved).
  async getFileDiff(sessionId: string, pathRaw: unknown): Promise<WireEnvelope<FsDiffResponse>> {
    const fs = await this.sessionFs(sessionId);
    try {
      const data = await fs.diff(fsDiffRequestSchema.parse({ path: pathRaw }));
      return ok(data);
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:open → { opened: true }. Resolve the workspace-bounded absolute path in
  // the sidecar, then launch the platform default handler (no terminal window).
  async openFile(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<{ opened: true }>> {
    const fs = await this.sessionFs(sessionId);
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const path = requireString(input['path'], 'path');
    const line = typeof input['line'] === 'number' ? input['line'] : undefined;
    try {
      const resolved = await fs.resolvePath(path);
      await launchDetached(openFileCommandFor(resolved.absolute, line));
      return ok({ opened: true as const });
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:reveal → { revealed: true }. Reveal the resolved path in the file
  // manager (Finder / Explorer / xdg-open parent dir).
  async revealFile(sessionId: string, inputRaw: unknown): Promise<WireEnvelope<{ revealed: true }>> {
    const fs = await this.sessionFs(sessionId);
    const input = (inputRaw ?? {}) as Record<string, unknown>;
    const path = requireString(input['path'], 'path');
    try {
      const resolved = await fs.resolvePath(path);
      await launchDetached(revealFileCommandFor(resolved.absolute));
      return ok({ revealed: true as const });
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // fs:open-in → { opened: true }. Open the resolved path in a whitelisted
  // external app; an unknown app id is a validation error and a launch failure
  // maps to INTERNAL_ERROR (kap-server parity).
  async openInApp(
    sessionId: string,
    appIdRaw: unknown,
    pathRaw: unknown,
    lineRaw?: unknown,
  ): Promise<WireEnvelope<{ opened: true }>> {
    const fs = await this.sessionFs(sessionId);
    const appId = requireString(appIdRaw, 'app_id');
    const path = requireString(pathRaw, 'path');
    const line = typeof lineRaw === 'number' ? lineRaw : undefined;
    if (!OPEN_IN_APP_IDS.includes(appId as OpenInAppId)) {
      throw new RPCError(REQUEST_INVALID, `unsupported app_id: ${appId}`);
    }
    let resolved: Awaited<ReturnType<ISessionFsService['resolvePath']>>;
    try {
      resolved = await fs.resolvePath(path);
    } catch (error) {
      throw mapFsError(error);
    }
    try {
      await launchDetached(
        openInAppCommandFor(appId as OpenInAppId, resolved.absolute, {
          line,
          isDirectory: resolved.isDirectory,
        }),
      );
    } catch (error) {
      throw new RPCError(
        INTERNAL_ERROR,
        `failed to open in ${appId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return ok({ opened: true as const });
  }

  /** Cold-resume the session and resolve its Session-scoped fs service. */
  private async sessionFs(sessionId: string): Promise<ISessionFsService> {
    const handle = await this.resumeSession(sessionId);
    return handle.accessor.get(ISessionFsService);
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
    return this.enqueueProviderWrite(async () => {
      const input = parseProviderInput(inputRaw, true);
      const config = await this.loadWritableConfig();
      const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
      if (providers[input.id] !== undefined) {
        throw new RPCError(REQUEST_INVALID, `provider ${input.id} already exists`);
      }

      const provider = providerConfigFromInput(input, input.id);
      await config.set(PROVIDERS_SECTION, { [input.id]: provider });
      await config.set(MODELS_SECTION, modelRecordsFromInput(input, input.id));

      const firstModel = input.models[0];
      const currentDefault = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
      if ((currentDefault === undefined || currentDefault.trim() === '') && firstModel !== undefined) {
        await config.replace(
          DEFAULT_MODEL_SECTION,
          provider.defaultModel ?? `${input.id}/${firstModel.model}`,
        );
      }

      const created = await this.scope.accessor.get(IModelCatalog).getProvider(input.id);
      return ok<Record<string, unknown>>({ ...created });
    });
  }

  // replaceProvider — PUT /providers/{id} → { provider }.
  async replaceProvider(
    idRaw: unknown,
    inputRaw: unknown,
  ): Promise<WireEnvelope<{ provider: Record<string, unknown> }>> {
    const existingId = requireString(idRaw, 'providerId');
    return this.enqueueProviderWrite(async () => {
      const input = parseProviderInput(inputRaw, false, existingId);
      const config = await this.loadWritableConfig();
      const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
      const current = providers[existingId];
      if (current === undefined) {
        throw new RPCError(PROVIDER_NOT_FOUND, `provider ${existingId} does not exist`);
      }
      if (current.oauth !== undefined) {
        throw new RPCError(REQUEST_INVALID, `provider ${existingId} is managed by OAuth`);
      }

      const newId = input.id;
      if (newId !== existingId && providers[newId] !== undefined) {
        throw new RPCError(REQUEST_INVALID, `provider ${newId} already exists`);
      }

      const nextProvider: ProviderConfig = {
        ...current,
        ...providerConfigFromInput(input, newId),
        apiKey: input.apiKey === undefined ? current.apiKey : input.apiKey,
      };
      const nextProviders = { ...providers };
      delete nextProviders[existingId];
      nextProviders[newId] = nextProvider;

      const models = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
      const newAliasKeys = new Set(
        input.models.map((entry) => `${newId}/${entry.model}`),
      );
      const collidingAliases = Object.entries(models)
        .filter(([, record]) => record.provider !== existingId)
        .map(([aliasId]) => aliasId)
        .filter((aliasId) => newAliasKeys.has(aliasId));
      if (collidingAliases.length > 0) {
        throw new RPCError(
          REQUEST_INVALID,
          `model alias key already owned by another provider: ${collidingAliases.join(', ')}`,
        );
      }
      const previousAliasIds = new Set(
        Object.entries(models)
          .filter(([, record]) => record.provider === existingId)
          .map(([aliasId]) => aliasId),
      );
      const nextModels = Object.fromEntries(
        Object.entries(models).filter(([, record]) => record.provider !== existingId),
      );
      Object.assign(nextModels, modelRecordsFromInput(input, newId, models, existingId));

      await config.replace(PROVIDERS_SECTION, nextProviders);
      await config.replace(MODELS_SECTION, nextModels);

      if (newId !== existingId) {
        const defaultProvider = config.inspect<string>(DEFAULT_PROVIDER_SECTION).userValue;
        if (defaultProvider === existingId) {
          await config.replace(DEFAULT_PROVIDER_SECTION, newId);
        }
        const defaultModel = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
        if (defaultModel !== undefined && previousAliasIds.has(defaultModel)) {
          const renamedModel = models[defaultModel]?.model;
          const renamedAlias =
            renamedModel === undefined ? undefined : `${newId}/${renamedModel}`;
          if (renamedAlias !== undefined && nextModels[renamedAlias] !== undefined) {
            await config.replace(DEFAULT_MODEL_SECTION, renamedAlias);
          }
        }
      }

      const provider = await this.scope.accessor.get(IModelCatalog).getProvider(newId);
      return ok({ provider: { ...provider } });
    });
  }

  // deleteProvider — DELETE /providers/{id} → { deleted: true }.
  async deleteProvider(idRaw: unknown): Promise<WireEnvelope<{ deleted: boolean }>> {
    const id = requireString(idRaw, 'providerId');
    return this.enqueueProviderWrite(async () => {
      const config = await this.loadWritableConfig();
      const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
      const provider = providers[id];
      if (provider === undefined) {
        throw new RPCError(PROVIDER_NOT_FOUND, `provider ${id} does not exist`);
      }
      if (provider.oauth !== undefined) {
        throw new RPCError(REQUEST_INVALID, `provider ${id} is managed by OAuth`);
      }

      const models = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
      const nextProviders = { ...providers };
      delete nextProviders[id];
      const nextModels = Object.fromEntries(
        Object.entries(models).filter(([, record]) => record.provider !== id),
      );
      await config.replace(PROVIDERS_SECTION, nextProviders);
      await config.replace(MODELS_SECTION, nextModels);
      return ok({ deleted: true });
    });
  }

  // refreshProvider — POST /providers/{id}:refresh.
  async refreshProvider(idRaw: unknown): Promise<WireEnvelope<WireProviderRefreshResult>> {
    const providerId = requireString(idRaw, 'providerId');
    const result = await this.klient.global.kosong.refreshProviders({ providerId });
    return ok(result);
  }

  // refreshAllProviders — POST /providers:refresh.
  async refreshAllProviders(): Promise<WireEnvelope<WireProviderRefreshResult>> {
    const result = await this.klient.global.kosong.refreshProviders();
    return ok(result);
  }

  // setDefaultModel — POST /models/{id}:set_default → SetDefaultModelResponse.
  async setDefaultModel(idRaw: unknown): Promise<WireEnvelope<Record<string, unknown>>> {
    const id = requireString(idRaw, 'modelId');
    const result = await this.klient.global.kosong.setDefaultModel(id);
    return ok<Record<string, unknown>>({ ...result });
  }

  private async loadWritableConfig(): Promise<IConfigService> {
    const config = this.scope.accessor.get(IConfigService);
    await config.ready;
    await this.scope.accessor.get(IKosongConfigService).ready;
    return config;
  }

  private enqueueProviderWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.providerWriteChain.then(task, task);
    this.providerWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface ProviderModelInput {
  readonly model: string;
  readonly displayName?: string;
  readonly maxContextSize: number;
}

interface ProviderInput {
  readonly id: string;
  readonly type: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly models: readonly ProviderModelInput[];
}

const PROVIDER_TYPES = new Set([
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
]);

function parseProviderInput(
  raw: unknown,
  requireId: boolean,
  fallbackId?: string,
): ProviderInput {
  if (!isRecord(raw)) throw new RPCError(REQUEST_INVALID, 'provider input must be an object');
  const idValue = raw['new_id'] ?? raw['id'] ?? fallbackId;
  const id = requireString(idValue, requireId ? 'provider id' : 'provider id or new_id');
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new RPCError(REQUEST_INVALID, `invalid provider id: ${id}`);
  }
  const type = requireString(raw['type'], 'provider type');
  if (!PROVIDER_TYPES.has(type)) {
    throw new RPCError(REQUEST_INVALID, `unsupported provider type: ${type}`);
  }
  if (!Array.isArray(raw['models']) || raw['models'].length === 0) {
    throw new RPCError(REQUEST_INVALID, 'provider must define at least one model');
  }
  const modelNames = new Set<string>();
  const models = raw['models'].map((value) => {
    if (!isRecord(value)) throw new RPCError(REQUEST_INVALID, 'provider model must be an object');
    const model = requireString(value['model'], 'model name');
    if (modelNames.has(model)) {
      throw new RPCError(REQUEST_INVALID, `duplicate model: ${model}`);
    }
    modelNames.add(model);
    const size = value['max_context_size'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new RPCError(REQUEST_INVALID, `model ${model} has an invalid context size`);
    }
    return {
      model,
      displayName: optionalString(value['display_name']),
      maxContextSize: size,
    };
  });
  const apiKey =
    Object.prototype.hasOwnProperty.call(raw, 'api_key')
      ? optionalString(raw['api_key']) ?? ''
      : undefined;
  const baseUrl = optionalString(raw['base_url']);
  if (baseUrl?.includes('${') === true) {
    throw new RPCError(REQUEST_INVALID, 'base_url must not contain an environment placeholder');
  }
  const defaultModel = optionalString(raw['default_model']);
  if (defaultModel !== undefined && !modelNames.has(defaultModel)) {
    throw new RPCError(REQUEST_INVALID, 'default_model must be one of models[].model');
  }
  return {
    id,
    type,
    apiKey,
    baseUrl,
    defaultModel,
    models,
  };
}

function providerConfigFromInput(input: ProviderInput, id: string): ProviderConfig {
  return {
    type: input.type,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    defaultModel:
      input.defaultModel === undefined ? undefined : `${id}/${input.defaultModel}`,
  };
}

function modelRecordsFromInput(
  input: ProviderInput,
  id: string,
  previous: ModelsSection = {},
  previousProviderId = id,
): ModelsSection {
  const records: ModelsSection = {};
  for (const item of input.models) {
    const previousRecord = Object.values(previous).find(
      (record) => record.provider === previousProviderId && record.model === item.model,
    );
    const alias = `${id}/${item.model}`;
    const record: ModelRecord = {
      ...previousRecord,
      provider: id,
      model: item.model,
      displayName: item.displayName,
      maxContextSize: item.maxContextSize,
    };
    records[alias] = record;
  }
  return records;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
 * wire error codes the daemon HTTP transport returns.
 */
function mapEngineError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (isError2(error)) {
    switch (error.code) {
      case 'session.not_found':
      case 'agent.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      case 'prompt.not_found':
        return new RPCError(PROMPT_NOT_FOUND, error.message);
      case 'session.fork_active_turn':
      case 'session.busy':
        return new RPCError(SESSION_BUSY, error.message);
      case 'compaction.unable':
        return new RPCError(COMPACTION_UNABLE, error.message);
      case 'session.undo_unavailable':
        return new RPCError(SESSION_UNDO_UNAVAILABLE, error.message);
      default:
        break;
    }
  }
  throw error;
}

/**
 * Mirror kap-server's fs `sendMappedError` (routes/fs.ts): translate the
 * `sessionFs` + `os.fs` domain Error2 codes onto the v1 wire codes. ENOTDIR
 * collapses into path-not-found, matching the route.
 */
function mapFsError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  const zodIssue = firstZodIssue(error);
  if (zodIssue !== undefined) {
    const path = zodIssue.path.map((p) => String(p)).join('.');
    const msg = path === '' ? zodIssue.message : `${path}: ${zodIssue.message}`;
    return new RPCError(REQUEST_INVALID, msg);
  }
  if (isError2(error)) {
    switch (error.code) {
      case 'fs.path_escapes':
        return new RPCError(FS_PATH_ESCAPES_SESSION, error.message);
      case 'fs.path_not_found':
      case 'os.fs.not_found':
      case 'os.fs.not_directory':
        return new RPCError(FS_PATH_NOT_FOUND, error.message);
      case 'fs.is_directory':
      case 'os.fs.is_directory':
        return new RPCError(FS_IS_DIRECTORY, error.message);
      case 'fs.already_exists':
      case 'os.fs.already_exists':
        return new RPCError(FS_ALREADY_EXISTS, error.message);
      case 'fs.is_binary':
        return new RPCError(FS_IS_BINARY, error.message);
      case 'fs.too_large':
        return new RPCError(FS_TOO_LARGE, error.message);
      case 'fs.too_many_results':
        return new RPCError(FS_TOO_MANY_RESULTS, error.message);
      case 'fs.grep_timeout':
        return new RPCError(FS_GREP_TIMEOUT, error.message);
      case 'fs.git_unavailable':
        return new RPCError(FS_GIT_UNAVAILABLE, error.message);
      case 'fs.permission_denied':
      case 'os.fs.permission_denied':
        return new RPCError(FS_PERMISSION_DENIED, error.message);
      case 'session.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      default:
        break;
    }
  }
  return new RPCError(
    INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Structurally detect a zod validation failure (the sidecar cannot import zod
 * directly — it is not a kimi-desktop dependency). Matches the shape the
 * request schemas throw so fs request validation maps onto VALIDATION_FAILED.
 */
function firstZodIssue(
  error: unknown,
): { path: readonly PropertyKey[]; message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  const first = issues[0] as { path?: unknown; message?: unknown } | undefined;
  if (first === undefined) return undefined;
  return {
    path: Array.isArray(first.path) ? (first.path as readonly PropertyKey[]) : [],
    message: typeof first.message === 'string' ? first.message : 'validation failed',
  };
}

/**
 * Mirror kap-server's workspaceFs `sendMappedError` (routes/workspaceFs.ts):
 * IHostFolderBrowser domain errors onto the folder-picker wire codes.
 */
function mapBrowseError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (error instanceof HostFolderNotAbsoluteError) {
    return new RPCError(REQUEST_INVALID, error.message);
  }
  if (error instanceof HostFolderNotFoundError) {
    return new RPCError(FS_PATH_NOT_FOUND, error.message);
  }
  if (error instanceof HostFolderPermissionError) {
    return new RPCError(FS_PERMISSION_DENIED, error.message);
  }
  throw error;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Mirrors kap-server `pageUndoMessages` (routes/sessions.ts). */
function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly unknown[],
  requestedPageSize: number | undefined,
): WirePage<WireMessage> {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(
      sessionId,
      index,
      message as Parameters<typeof toProtocolMessage>[2],
      sessionCreatedAtMs,
    ),
  ) as unknown as WireMessage[];
  const desc = [...all].reverse();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
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
