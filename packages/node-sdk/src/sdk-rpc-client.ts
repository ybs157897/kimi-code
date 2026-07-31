import type { Kaos } from '@moonshot-ai/kaos';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';
import type {
  AgentEventPayloads,
  AgentHandle,
  IDisposable,
  Interaction,
  SessionHandle,
  ShellCommandResult,
} from '@moonshot-ai/klient';
import { approvalRequestSchema } from '@moonshot-ai/klient/contract/session/approval';
import { questionRequestSchema } from '@moonshot-ai/klient/contract/session/question';
import { eventSchema, ToolInputDisplaySchema } from '@moonshot-ai/protocol';

import { KimiAuthFacade } from '#/auth';
import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
} from '#/events';
import { KimiHarness } from '#/kimi-harness';
import {
  SDKRpcClientBase,
  type ActivateExpertTeamRpcInput,
  type ActivateExtensionCommandRpcInput,
  type ActivatePluginCommandRpcInput,
  type ActivateSkillRpcInput,
  type ImportContextRpcInput,
  type ReconnectMcpServerRpcInput,
  type ReloadSessionRpcInput,
  type ResolvedCoreAPI,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
  type SetSessionModelRpcInput,
  type SetSessionModelRpcResult,
  type SetSessionPermissionRpcInput,
  type SetSessionPlanModeRpcInput,
  type SetSessionSwarmModeRpcInput,
  type SetSessionThinkingRpcInput,
  type UpdateSessionMetadataRpcInput,
} from '#/rpc';
import {
  ensureConfigFile,
  loadRuntimeConfigSafe,
  mergeConfigPatch,
  readConfigFileForUpdate,
  writeConfigFile,
} from '#/sdk-config';
import { ErrorCodes, KimiError, makeErrorPayload } from '#/sdk-errors';
import { mapV2BoundaryError } from '#/sdk-rpc-errors';
import type { ExperimentalFeatureState } from '#/sdk-flags';
import { ImageLimits } from '#/sdk-image';
import {
  flushDiagnosticLogs,
  registerDiagnosticLogBackend,
  resolveActiveGlobalLogPath,
  type DiagnosticLogRegistration,
} from '#/sdk-logger';
import {
  completeMcpAuthorization,
  isAlreadyAuthorizedError,
  listSdkMcpServers,
  requireMcpServer,
  requireRemoteMcpServer,
  toSdkMcpServerConfig,
  toV2McpCatalogInput,
} from '#/sdk-rpc-mcp';
import { limitAgentReplayByTurns } from '#/sdk-model';
import {
  assertNoKaosOverrides,
  assertSupportedCreateSessionOptions,
  imageConfig,
  normalizeAgentId,
  normalizeMcpServerName,
  normalizeNamedResource,
  normalizeOptionalSessionTitle,
  normalizeSessionId,
  normalizeSessionTitle,
  normalizeWorkDir,
  normalizeWorkspaceSkillsWorkDir,
  parseExtensionCommandName,
  sessionNotFound,
  unsupportedV2Option,
} from '#/sdk-rpc-normalize';
import { resolveConfigPath, resolveKimiHome } from '#/sdk-paths';
import {
  projectAgentEventPayload,
  projectBackgroundTask,
  projectCronTasks,
  projectExpertTeamChangedEvent,
  projectExpertTeamStatus,
  projectModelCatalogChangedEvent,
} from '#/sdk-rpc-projections';
import {
  resolveWorkspaceIds,
  sessionBelongsToWorkDir,
  toSessionSummary,
} from '#/sdk-rpc-sessions';
import { noopTelemetryClient, type TelemetryClient } from '#/sdk-telemetry';
import type {
  BeginGlobalMcpServerAuthResult,
  CoreOverrides,
  ForwardedAgentEventName,
  OAuthTokenProviderResolver,
} from '#/sdk-rpc-types';
import {
  handleKimiV2CompletedPrintTurn,
  createKimiV2Runtime,
  waitForKimiV2PrintBackgroundTasks,
  type KimiV2Runtime,
  type KimiV2RuntimeOptions,
} from '#/v2/runtime';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  BackgroundTaskInfo,
  CompactOptions,
  CreateSessionOptions,
  ConfigDiagnostics,
  CreateGoalInput,
  ExportSessionInput,
  ExportSessionResult,
  ExpertTeamDefinition,
  ExpertTeamSnapshot,
  ExpertTeamStatusSnapshot,
  ExtensionCommandDef,
  ForkSessionInput,
  GetConfigOptions,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  KimiConfig,
  KimiConfigPatch,
  KimiHarnessOptions,
  KimiHostIdentity,
  ListSessionsOptions,
  McpServerInfo,
  McpStartupMetrics,
  McpServerConfig,
  McpTestResult,
  OAuthRefreshOutcome,
  PermissionMode,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PromptInput,
  ReloadSummary,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedAgentState,
  ResumedSessionSummary,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SkillSummary,
} from '#/types';

interface V2CoreCallbacks {
  emitEvent(event: Event): void;
  requestApproval(
    request: ApprovalRequest & { readonly sessionId: string; readonly agentId: string },
  ): Promise<ApprovalResponse>;
  requestQuestion(
    request: QuestionRequest & { readonly sessionId: string; readonly agentId: string },
  ): Promise<QuestionResult>;
}

interface V2AgentSubscription {
  readonly handle: AgentHandle;
  readonly disposables: IDisposable[];
  ready: Promise<void>;
}

interface V2SessionSubscription {
  readonly id: string;
  readonly handle: SessionHandle;
  readonly agents: Map<string, V2AgentSubscription>;
  readonly disposables: IDisposable[];
  readonly processingInteractions: Set<string>;
  active: boolean;
}

const FORWARDED_AGENT_EVENT_NAMES = [
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.retrying',
  'turn.step.interrupted',
  'turn.step.completed',
  'assistant.delta',
  'hook.result',
  'thinking.delta',
  'tool.call.delta',
  'tool.call.started',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'tool.result',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'goal.updated',
  'skill.activated',
  'plugin_command.activated',
  'error',
  'warning',
  'notice',
  'agent.status.updated',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'subagent.spawned',
  'subagent.started',
  'subagent.suspended',
  'subagent.completed',
  'subagent.failed',
  'task.started',
  'task.terminated',
  'cron.fired',
  'mcp.server.status',
  'tool.list.updated',
] as const satisfies readonly ForwardedAgentEventName[];

const SDK_APPROVAL_REQUEST_SCHEMA = approvalRequestSchema.extend({
  display: ToolInputDisplaySchema,
});

/**
 * Narrow root-SDK compatibility adapter over the v2 Klient facade.
 *
 * This deliberately maps only the usable baseline. Unmapped legacy methods
 * fail with `not_implemented`; they never return placeholder state.
 */
class V2CoreAdapter {
  readonly imageLimits: ImageLimits;
  readonly sessions = new Map<string, true>();
  readonly kimiRequestHeaders: Readonly<Record<string, string>> | undefined;

  private readonly subscriptions = new Map<string, V2SessionSubscription>();
  private readonly globalDisposables: IDisposable[] = [];
  private readonly runtimeReady: Promise<KimiV2Runtime>;
  private readonly diagnosticLogRegistration: DiagnosticLogRegistration;
  private readonly configPath: string | undefined;
  private state: 'open' | 'closing' | 'closed' = 'open';
  private activeCalls = 0;
  private idleWaiters: Array<() => void> = [];
  private closePromise: Promise<void> | undefined;

  constructor(
    options: KimiV2RuntimeOptions,
    kimiRequestHeaders: Readonly<Record<string, string>> | undefined,
    private readonly callbacks: V2CoreCallbacks,
  ) {
    this.kimiRequestHeaders = kimiRequestHeaders;
    this.configPath = options.configPath;
    this.imageLimits = new ImageLimits(
      process.env,
      options.configPath === undefined
        ? undefined
        : imageConfig(loadRuntimeConfigSafe(options.configPath).config),
    );
    this.runtimeReady = createKimiV2Runtime(options);
    this.diagnosticLogRegistration = registerDiagnosticLogBackend(
      this.runtimeReady.then((runtime) => runtime.diagnostics),
    );
    // Boot starts eagerly. Keep the rejection observed until the first public
    // operation (or close) awaits and reports it to the caller.
    void this.runtimeReady.catch(() => undefined);
    void this.runtimeReady.then(
      (runtime) => {
        this.attachGlobalEvents(runtime);
      },
      () => undefined,
    );
  }

  async whenReady(): Promise<void> {
    await this.run(async () => undefined);
  }

  async getConfig(options: GetConfigOptions = {}): Promise<KimiConfig> {
    return this.run(async (runtime) => {
      if (options.reload === true) {
        await runtime.klient.global.config.reload();
      }
      const config =
        this.configPath === undefined
          ? await runtime.klient.global.config.getAll()
          : loadRuntimeConfigSafe(this.configPath).config;
      this.imageLimits.setConfig(imageConfig(config));
      return config;
    });
  }

  async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    return this.run(async (runtime) => {
      if (this.configPath === undefined) {
        throw unsupportedV2Method(
          'setConfig',
          'The runtime did not expose a writable config path.',
        );
      }
      const next = mergeConfigPatch(readConfigFileForUpdate(this.configPath), patch);
      await writeConfigFile(this.configPath, next);
      await runtime.klient.global.config.reload();
      this.imageLimits.setConfig(imageConfig(next));
      return next;
    });
  }

  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    return this.run(async (runtime) => {
      const runtimeDiagnostics = await runtime.klient.global.config.diagnostics();
      const fileWarnings =
        this.configPath === undefined
          ? []
          : loadRuntimeConfigSafe(this.configPath).fileWarnings;
      return {
        warnings: [
          ...fileWarnings,
          ...runtimeDiagnostics.map((diagnostic) => diagnostic.message),
        ],
      };
    });
  }

  async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.run((runtime) => runtime.klient.global.flags.list());
  }

  async removeProvider(providerId: string): Promise<KimiConfig> {
    return this.run(async (runtime) => {
      const normalized = normalizeNamedResource(providerId, 'Provider id');
      await runtime.klient.global.kosong.removeProvider(normalized);
      const config =
        this.configPath === undefined
          ? await runtime.klient.global.config.getAll()
          : loadRuntimeConfigSafe(this.configPath).config;
      this.imageLimits.setConfig(imageConfig(config));
      return config;
    });
  }

  async listGlobalMcpServers(): Promise<readonly McpServerConfig[]> {
    return this.run(async (runtime) => {
      const entries = await runtime.klient.global.mcp.catalog.list();
      return entries.map(toSdkMcpServerConfig);
    });
  }

  async addGlobalMcpServer(
    server: McpServerConfig,
  ): Promise<readonly McpServerConfig[]> {
    return this.run(async (runtime) => {
      const input = toV2McpCatalogInput(server);
      await runtime.klient.global.mcp.catalog.add(input);
      return listSdkMcpServers(runtime.klient);
    });
  }

  async updateGlobalMcpServer(
    server: McpServerConfig,
  ): Promise<readonly McpServerConfig[]> {
    return this.run(async (runtime) => {
      const input = toV2McpCatalogInput(server);
      await runtime.klient.global.mcp.catalog.update(input);
      return listSdkMcpServers(runtime.klient);
    });
  }

  async removeGlobalMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    return this.run(async (runtime) => {
      const normalized = normalizeMcpServerName(name);
      await runtime.klient.global.mcp.catalog.remove(normalized);
      return listSdkMcpServers(runtime.klient);
    });
  }

  async beginGlobalMcpServerAuth(
    name: string,
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.run(async (runtime) => {
      const entry = await requireRemoteMcpServer(runtime.klient, name);
      try {
        const flow = await runtime.klient.global.mcp.oauth.begin({
          serverName: entry.name,
          serverUrl: entry.config.url,
        });
        return {
          status: 'authorization-required',
          flowId: flow.flowId,
          authorizationUrl: flow.authorizationUrl,
        };
      } catch (error) {
        if (isAlreadyAuthorizedError(error)) {
          return { status: 'already-authorized' };
        }
        throw error;
      }
    });
  }

  async completeGlobalMcpServerAuth(
    input: { readonly flowId: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run((runtime) =>
      completeMcpAuthorization(runtime.klient, input, signal),
    );
  }

  async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    await this.run((runtime) =>
      runtime.klient.global.mcp.oauth.cancel(
        normalizeNamedResource(flowId, 'MCP OAuth flow id'),
      ),
    );
  }

  async resetGlobalMcpServerAuth(name: string): Promise<void> {
    await this.run(async (runtime) => {
      const entry = await requireRemoteMcpServer(runtime.klient, name);
      await runtime.klient.global.mcp.oauth.invalidate({
        serverName: entry.name,
        serverUrl: entry.config.url,
        scope: 'all',
      });
    });
  }

  async testGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return this.run(async (runtime) => {
      const entry = await requireMcpServer(runtime.klient, name);
      const result = await runtime.klient.global.mcp.probe.run({
        serverName: entry.name,
        config: entry.config,
        cwd:
          options.cwd === undefined
            ? undefined
            : normalizeWorkDir(options.cwd),
      });
      return {
        success: result.success,
        output: result.success
          ? `Available tools: ${result.toolCount}`
          : result.error ?? 'MCP server probe failed.',
      };
    });
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return this.run(async (runtime) => {
      const workDir =
        options.workDir === undefined ? undefined : normalizeWorkDir(options.workDir);
      const sessionId =
        options.sessionId === undefined ? undefined : normalizeSessionId(options.sessionId);

      if (sessionId !== undefined) {
        const summary = await runtime.klient.global.sessions.get(sessionId);
        if (summary === undefined || summary.archived) return [];
        if (
          workDir !== undefined &&
          !(await sessionBelongsToWorkDir(runtime.klient, summary, workDir))
        ) {
          return [];
        }
        return [await toSessionSummary(runtime.klient, summary)];
      }

      const workspaceIds =
        workDir === undefined
          ? undefined
          : await resolveWorkspaceIds(runtime.klient, workDir);
      if (workspaceIds?.length === 0) return [];

      const summaries: SessionSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.klient.global.sessions.list({
          workspaceIds,
          includeArchived: false,
          cursor,
        });
        summaries.push(
          ...(await Promise.all(
            page.items.map((summary) => toSessionSummary(runtime.klient, summary)),
          )),
        );
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return summaries;
    });
  }

  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    return this.run((runtime) =>
      runtime.klient.global.skills.listWorkspace(
        normalizeWorkspaceSkillsWorkDir(workDir),
      ),
    );
  }

  async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    assertSupportedCreateSessionOptions(input);
    return this.run(async (runtime) => {
      const workDir = normalizeWorkDir(input.workDir);
      const configuredDefaultModel =
        input.model === undefined
          ? await runtime.klient.global.config.get<string | undefined>('defaultModel')
          : undefined;
      const shouldBindMainAgent =
        input.model !== undefined ||
        input.thinking !== undefined ||
        (configuredDefaultModel !== undefined && configuredDefaultModel.length > 0);
      await runtime.klient.global.mcp.catalog.list();
      const meta = await runtime.klient.global.sessions.create({
        id: input.id === undefined ? undefined : normalizeSessionId(input.id),
        workDir,
        additionalDirs: input.additionalDirs,
        metadata: input.metadata,
        // A v2 session only materializes and binds its main Agent when a
        // binding is supplied. Keep the fields optional so the Profile
        // service can resolve the configured default model and thinking.
        mainAgentBinding: shouldBindMainAgent
          ? {
              profile: 'agent',
              model: input.model,
              thinking: input.thinking,
              strictThinking: input.thinking === undefined ? undefined : true,
            }
          : undefined,
      });
      const session = runtime.klient.session(meta.id);

      try {
        if (input.permission !== undefined) {
          await session.agent('main').setPermission(input.permission);
        }

        const indexed = await runtime.klient.global.sessions.get(meta.id);
        if (indexed === undefined) {
          throw new KimiError(
            ErrorCodes.SESSION_STATE_NOT_FOUND,
            `Created session "${meta.id}" is missing from the v2 session index.`,
          );
        }
        const workspace = await session.workspace.get();
        const summary = await toSessionSummary(
          runtime.klient,
          indexed,
          workspace.additionalDirs,
        );
        await this.attachSession(runtime, summary.id, ['main']);
        this.sessions.set(summary.id, true);
        return summary;
      } catch (error) {
        this.detachSession(meta.id);
        await session.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    return this.run((runtime) => this.restoreSession(runtime, input));
  }

  async reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    return this.run(async (runtime) => {
      const sessionId = normalizeSessionId(input.sessionId);
      this.detachSession(sessionId);
      await runtime.klient.session(sessionId).close();
      const summary = await this.restoreSession(runtime, { id: sessionId });
      if (input.forcePluginSessionStartReminder === true) {
        await runtime.klient
          .session(sessionId)
          .agent('main')
          .plugins.refreshSessionStartReminder();
      }
      return summary;
    });
  }

  async forkSession(input: ForkSessionInput): Promise<ResumedSessionSummary> {
    return this.run(async (runtime) => {
      const sourceSessionId = normalizeSessionId(input.id);
      const source = await runtime.klient.global.sessions.get(sourceSessionId);
      if (source === undefined) {
        throw sessionNotFound(sourceSessionId);
      }
      const sourceHandle = runtime.klient.session(sourceSessionId);
      const metadata = await sourceHandle.fork({
        newSessionId:
          input.forkId === undefined ? undefined : normalizeSessionId(input.forkId),
        title: normalizeOptionalSessionTitle(input.title),
        metadata: input.metadata,
        userVisibleTurnIndex: input.turnIndex,
      });
      const indexed = await runtime.klient.global.sessions.get(metadata.id);
      if (indexed === undefined) {
        throw new KimiError(
          ErrorCodes.SESSION_STATE_NOT_FOUND,
          `Forked session "${metadata.id}" is missing from the v2 session index.`,
        );
      }

      const handle = runtime.klient.session(metadata.id);
      try {
        const [workspace, warnings] = await Promise.all([
          handle.workspace.get(),
          handle.warnings.list(),
        ]);
        const agentIds = [...new Set(['main', ...Object.keys(metadata.agents ?? {})])];
        const agents: Record<string, ResumedAgentState> = {};
        await Promise.all(
          agentIds.map(async (agentId) => {
            agents[agentId] = await handle.agent(agentId).replay.read();
          }),
        );
        const summary = await toSessionSummary(
          runtime.klient,
          indexed,
          workspace.additionalDirs,
        );
        await this.attachSession(runtime, summary.id, ['main']);
        this.sessions.set(summary.id, true);
        return {
          ...summary,
          sessionMetadata: metadata,
          agents,
          warning: warnings[0]?.message,
        };
      } catch (error) {
        this.detachSession(metadata.id);
        await handle.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.run(async (runtime) => {
      const normalized = normalizeSessionId(sessionId);
      const indexed = await runtime.klient.global.sessions.get(normalized);
      if (indexed === undefined) {
        throw sessionNotFound(normalized);
      }

      this.detachSession(normalized);
      try {
        await runtime.klient.global.sessionStore.delete({
          workspaceId: indexed.workspaceId,
          sessionId: normalized,
        });
      } finally {
        this.sessions.delete(normalized);
      }
    });
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    await this.run(async (runtime) => {
      const sessionId = normalizeSessionId(input.id);
      const title = normalizeSessionTitle(input.title);
      const indexed = await runtime.klient.global.sessions.get(sessionId);
      if (indexed === undefined) {
        throw sessionNotFound(sessionId);
      }

      const handle = runtime.klient.session(sessionId);
      const owned = this.sessions.has(sessionId);
      if (!owned && !(await handle.restore())) {
        throw sessionNotFound(sessionId);
      }
      try {
        await handle.setTitle(title);
      } finally {
        if (!owned) await handle.close();
      }
    });
  }

  async prompt(
    sessionId: string,
    agentId: string,
    input: PromptInput,
    disabledTools?: readonly string[],
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.prompt({ input, disabledTools });
    });
  }

  async steer(sessionId: string, agentId: string, input: PromptInput): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.steer({ input });
    });
  }

  async cancel(sessionId: string, agentId: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.cancel();
    });
  }

  async getStatus(sessionId: string, agentId: string): Promise<SessionStatus> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      const [profile, permission, context, usage, plan, swarmMode, expertTeam] =
        await Promise.all([
          agent.handle.profile.get(),
          agent.handle.getPermission(),
          agent.handle.getContext(),
          agent.handle.getUsage(),
          agent.handle.getPlan(),
          agent.handle.swarm.isActive(),
          subscription.handle.expertTeam.get(),
        ]);
      const maxContextTokens =
        profile.modelCapabilities.max_input_tokens ??
        profile.modelCapabilities.max_context_tokens;
      const contextTokens = context.tokenCount;
      const hasUsage =
        usage.byModel !== undefined ||
        usage.total !== undefined ||
        usage.currentTurn !== undefined;
      return {
        model: profile.modelAlias,
        thinkingEffort: profile.thinkingLevel,
        permission,
        planMode: plan !== null,
        swarmMode,
        expertTeam,
        contextTokens,
        maxContextTokens,
        contextUsage: maxContextTokens > 0 ? contextTokens / maxContextTokens : 0,
        usage: hasUsage ? usage : undefined,
      };
    });
  }

  async runShellCommand(
    sessionId: string,
    agentId: string,
    input: { readonly command: string; readonly commandId?: string },
  ): Promise<ShellCommandResult> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.runShellCommand(input);
    });
  }

  async cancelShellCommand(
    sessionId: string,
    agentId: string,
    commandId: string,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.cancelShellCommand({ commandId });
    });
  }

  async generateAgentsMd(sessionId: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      await subscription.handle.init.generateAgentsMd();
    });
  }

  async getSessionWarnings(sessionId: string) {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return subscription.handle.warnings.list();
    });
  }

  async addAdditionalDir(
    sessionId: string,
    input: { readonly path: string; readonly persist: boolean },
  ): Promise<AddAdditionalDirResult> {
    return this.run(async (runtime) => {
      if (!input.persist) {
        throw new KimiError(
          ErrorCodes.NOT_IMPLEMENTED,
          'addAdditionalDir with persist:false cannot preserve the root SDK resume contract on v2.',
          { details: { persist: false } },
        );
      }
      const subscription = await this.ensureSession(runtime, sessionId);
      return subscription.handle.workspace.addAdditionalDir(input);
    });
  }

  async startBtw(sessionId: string): Promise<string> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agentId = await subscription.handle.btw.start();
      await this.ensureAgent(subscription, agentId);
      return agentId;
    });
  }

  async clearContext(sessionId: string, agentId: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.clearContext();
    });
  }

  async importContext(
    sessionId: string,
    agentId: string,
    input: { readonly content: string; readonly source: string },
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.importContext(input);
    });
  }

  async setModel(
    sessionId: string,
    agentId: string,
    model: string,
  ): Promise<SetSessionModelRpcResult> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.setModel(model);
    });
  }

  async setThinking(
    sessionId: string,
    agentId: string,
    effort: string,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.profile.setThinking(effort);
    });
  }

  async setPermission(
    sessionId: string,
    agentId: string,
    mode: PermissionMode,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.setPermission(mode);
    });
  }

  async updateSessionMetadata(sessionId: string, metadata: JsonObject): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const current = await subscription.handle.get();
      await subscription.handle.update({
        custom: { ...current.custom, ...metadata },
      });
    });
  }

  async setPlanMode(
    sessionId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      if (enabled) {
        await agent.handle.enterPlan();
      } else {
        await agent.handle.cancelPlan();
      }
    });
  }

  async setSwarmMode(
    sessionId: string,
    agentId: string,
    input: SetSessionSwarmModeRpcInput,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      if (input.enabled) {
        await agent.handle.swarm.enter(input.trigger);
      } else {
        await agent.handle.swarm.exit();
      }
    });
  }

  async swarm(
    sessionId: string,
    agentId: string,
    input: PromptInput,
    disabledTools?: readonly string[],
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.swarm.enter('task');
      await agent.handle.prompt({ input, disabledTools });
    });
  }

  async getPlan(sessionId: string, agentId: string): Promise<SessionPlan> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.getPlan();
    });
  }

  async clearPlan(sessionId: string, agentId: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.clearPlan();
    });
  }

  async compact(
    sessionId: string,
    agentId: string,
    input: CompactOptions,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.compact({ instruction: input.instruction });
    });
  }

  async cancelCompaction(sessionId: string, agentId: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.cancelCompaction();
    });
  }

  async undoHistory(
    sessionId: string,
    agentId: string,
    count: number,
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.undoHistory(count);
    });
  }

  async getContext(sessionId: string, agentId: string) {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.getContext();
    });
  }

  async getUsage(sessionId: string, agentId: string): Promise<SessionUsage> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.getUsage();
    });
  }

  async listSkills(sessionId: string): Promise<readonly SkillSummary[]> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return subscription.handle.skills.list();
    });
  }

  async listPluginCommands(sessionId: string): Promise<readonly PluginCommandDef[]> {
    return this.run(async (runtime) => {
      await this.ensureSession(runtime, sessionId);
      return runtime.klient.global.plugins.listCommands();
    });
  }

  async listExpertTeams(sessionId: string): Promise<readonly ExpertTeamDefinition[]> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return subscription.handle.expertTeam.list();
    });
  }

  async getExpertTeam(sessionId: string): Promise<ExpertTeamSnapshot | null> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return subscription.handle.expertTeam.get();
    });
  }

  async getExpertTeamStatus(
    sessionId: string,
  ): Promise<ExpertTeamStatusSnapshot | null> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return projectExpertTeamStatus(await subscription.handle.expertTeam.get());
    });
  }

  async activateExpertTeam(
    sessionId: string,
    pluginId: string,
  ): Promise<ExpertTeamSnapshot> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return subscription.handle.expertTeam.activate(pluginId);
    });
  }

  async deactivateExpertTeam(sessionId: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      await subscription.handle.expertTeam.deactivate();
    });
  }

  async listExtensionCommands(sessionId: string): Promise<readonly ExtensionCommandDef[]> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const commands = await subscription.handle.extensions.listCommands();
      return commands.map((command) => ({
        extensionId: command.extensionId,
        name: command.name,
        description: command.description,
      }));
    });
  }

  async activateExtensionCommand(
    sessionId: string,
    agentId: string,
    input: { readonly name: string; readonly args?: string },
  ): Promise<undefined> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      const command = parseExtensionCommandName(input.name);
      const activated = await agent.handle.extensions.activateCommand({
        ...command,
        args: input.args,
      });
      if (!activated) {
        throw new KimiError(
          ErrorCodes.REQUEST_INVALID,
          `Extension command "${input.name}" could not be activated.`,
          { details: command },
        );
      }
    });
    return undefined;
  }

  async getCronTasks(sessionId: string): Promise<GetCronTasksResult> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      return projectCronTasks(
        await subscription.handle.cron.list(),
        (taskId) => subscription.handle.cron.getNextFireForTask(taskId),
      );
    });
  }

  async listBackgroundTasks(
    sessionId: string,
    agentId: string,
    input: { readonly activeOnly?: boolean; readonly limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      const tasks = await agent.handle.getTasks(input);
      return tasks.map(projectBackgroundTask);
    });
  }

  async getBackgroundTaskOutput(
    sessionId: string,
    agentId: string,
    input: { readonly taskId: string; readonly tail?: number },
  ): Promise<string> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.getTaskOutput(input);
    });
  }

  async stopBackgroundTask(
    sessionId: string,
    agentId: string,
    input: { readonly taskId: string; readonly reason?: string },
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.stopTask(input);
    });
  }

  async detachBackgroundTask(
    sessionId: string,
    agentId: string,
    taskId: string,
  ): Promise<BackgroundTaskInfo | undefined> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      const task = await agent.handle.detachTask({ taskId });
      return task === undefined ? undefined : projectBackgroundTask(task);
    });
  }

  async waitForBackgroundTasksOnPrint(sessionId: string): Promise<void> {
    await this.run(async (runtime) => {
      await this.ensureSession(runtime, sessionId);
      await waitForKimiV2PrintBackgroundTasks(runtime, sessionId);
    });
  }

  async handlePrintMainTurnCompleted(
    sessionId: string,
  ): Promise<'finish' | 'continue'> {
    return this.run(async (runtime) => {
      await this.ensureSession(runtime, sessionId);
      return handleKimiV2CompletedPrintTurn(runtime, sessionId);
    });
  }

  async createGoal(
    sessionId: string,
    agentId: string,
    input: CreateGoalInput,
  ): Promise<GoalSnapshot> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.goal.create(input);
    });
  }

  async getGoal(sessionId: string, agentId: string): Promise<GoalToolResult> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return { goal: await agent.handle.goal.get() };
    });
  }

  async pauseGoal(sessionId: string, agentId: string): Promise<GoalSnapshot> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.goal.pause();
    });
  }

  async resumeGoal(sessionId: string, agentId: string): Promise<GoalSnapshot> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.goal.resume();
    });
  }

  async cancelGoal(sessionId: string, agentId: string): Promise<GoalSnapshot> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      return agent.handle.goal.cancel();
    });
  }

  async listMcpServers(sessionId: string): Promise<readonly McpServerInfo[]> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, 'main');
      return agent.handle.mcp.list();
    });
  }

  async getMcpStartupMetrics(sessionId: string): Promise<McpStartupMetrics> {
    return this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, 'main');
      return { durationMs: await agent.handle.mcp.initialLoadDurationMs() };
    });
  }

  async reconnectMcpServer(sessionId: string, name: string): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, 'main');
      await agent.handle.mcp.reconnect(name);
    });
  }

  async listPlugins(): Promise<readonly PluginSummary[]> {
    return this.run((runtime) => runtime.klient.global.plugins.list());
  }

  async installPlugin(source: string): Promise<PluginSummary> {
    return this.run((runtime) => runtime.klient.global.plugins.install(source));
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    await this.run((runtime) =>
      runtime.klient.global.plugins.setEnabled({ id, enabled }),
    );
  }

  async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    await this.run((runtime) =>
      runtime.klient.global.plugins.setMcpServerEnabled({ id, server, enabled }),
    );
  }

  async removePlugin(id: string): Promise<void> {
    await this.run((runtime) => runtime.klient.global.plugins.remove(id));
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    return this.run((runtime) => runtime.klient.global.plugins.reload());
  }

  async getPluginInfo(id: string): Promise<PluginInfo> {
    return this.run((runtime) => runtime.klient.global.plugins.info(id));
  }

  async activateSkill(
    sessionId: string,
    agentId: string,
    input: { readonly name: string; readonly args?: string },
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.skills.activate(input);
    });
  }

  async activatePluginCommand(
    sessionId: string,
    agentId: string,
    input: {
      readonly pluginId: string;
      readonly commandName: string;
      readonly args?: string;
    },
  ): Promise<void> {
    await this.run(async (runtime) => {
      const subscription = await this.ensureSession(runtime, sessionId);
      const agent = await this.ensureAgent(subscription, agentId);
      await agent.handle.activatePluginCommand(input);
    });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    return this.run(async (runtime) => {
      await flushDiagnosticLogs();
      return runtime.hostedSessionExport.export({
        sessionId: normalizeSessionId(input.id),
        outputPath: input.outputPath,
        includeGlobalLog: input.includeGlobalLog,
        version: input.version,
        installSource: input.installSource,
        shellEnv: input.shellEnv,
      }, {
        globalLogPath: await resolveActiveGlobalLogPath(),
      });
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.run(async (runtime) => {
      const normalized = normalizeSessionId(sessionId);
      this.detachSession(normalized);
      try {
        await runtime.klient.session(normalized).close();
      } finally {
        this.sessions.delete(normalized);
      }
    });
  }

  async createSessionWithOverrides(
    input: CreateSessionOptions,
    overrides: CoreOverrides,
  ): Promise<SessionSummary> {
    assertNoKaosOverrides(overrides);
    return this.createSession(input);
  }

  async resumeSessionWithOverrides(
    input: ResumeSessionInput,
    overrides: CoreOverrides,
  ): Promise<ResumedSessionSummary> {
    assertNoKaosOverrides(overrides);
    return this.resumeSession(input);
  }

  private async restoreSession(
    runtime: KimiV2Runtime,
    input: ResumeSessionInput,
  ): Promise<ResumedSessionSummary> {
    const sessionId = normalizeSessionId(input.id);
    const indexed = await runtime.klient.global.sessions.get(sessionId);
    if (indexed === undefined) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${sessionId}" does not exist.`,
      );
    }

    const session = runtime.klient.session(sessionId);
    if (!(await session.restore())) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${sessionId}" does not exist.`,
      );
    }

    try {
      for (const path of input.additionalDirs ?? []) {
        await session.workspace.addAdditionalDir({ path, persist: false });
      }

      const [metadata, workspace, warnings] = await Promise.all([
        session.get(),
        session.workspace.get(),
        session.warnings.list(),
      ]);
      const refreshed = await runtime.klient.global.sessions.get(sessionId);
      if (refreshed === undefined) {
        throw new KimiError(
          ErrorCodes.SESSION_STATE_NOT_FOUND,
          `Resumed session "${sessionId}" is missing from the v2 session index.`,
        );
      }

      const agentIds =
        input.includeSubagents === true
          ? [...new Set(['main', ...Object.keys(metadata.agents ?? {})])]
          : ['main'];
      const agents: Record<string, ResumedAgentState> = {};
      await Promise.all(
        agentIds.map(async (agentId) => {
          const state = await session.agent(agentId).replay.read();
          const replay = limitAgentReplayByTurns(state.replay, input.replayTurnLimit);
          agents[agentId] = replay === state.replay ? state : { ...state, replay };
        }),
      );

      const summary = await toSessionSummary(
        runtime.klient,
        refreshed,
        workspace.additionalDirs,
      );
      await this.attachSession(runtime, sessionId, agentIds);
      this.sessions.set(sessionId, true);
      return {
        ...summary,
        sessionMetadata: metadata,
        agents,
        warning: warnings[0]?.message,
      };
    } catch (error) {
      this.detachSession(sessionId);
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensureSession(
    runtime: KimiV2Runtime,
    sessionId: string,
  ): Promise<V2SessionSubscription> {
    const normalized = normalizeSessionId(sessionId);
    const existing = this.subscriptions.get(normalized);
    if (existing !== undefined && existing.active) return existing;
    return this.attachSession(runtime, normalized, ['main']);
  }

  private async attachSession(
    runtime: KimiV2Runtime,
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<V2SessionSubscription> {
    this.detachSession(sessionId);
    const handle = runtime.klient.session(sessionId);
    const subscription: V2SessionSubscription = {
      id: sessionId,
      handle,
      agents: new Map(),
      disposables: [],
      processingInteractions: new Set(),
      active: true,
    };
    this.subscriptions.set(sessionId, subscription);

    try {
      subscription.disposables.push(
        handle.events.onError((error) => {
          this.reportSubscriptionError(subscription, 'session event stream', error);
        }),
        handle.events.on('metadata.changed', (change) => {
          void this.forwardMetadataChange(subscription, change.changed);
        }),
        handle.events.on('interactions.changed', (interactions) => {
          this.processInteractions(subscription, interactions);
        }),
        handle.events.on('expert-team.changed', (snapshot) => {
          if (!subscription.active) return;
          this.callbacks.emitEvent(
            projectExpertTeamChangedEvent(subscription.id, snapshot),
          );
        }),
      );

      const pending = await handle.interactions.list();
      await Promise.all(
        [...new Set(agentIds.map(normalizeAgentId))].map((agentId) =>
          this.ensureAgent(subscription, agentId),
        ),
      );
      // Memory Klient resolves scope listeners asynchronously. The scoped
      // reads above materialize the handles; this checkpoint lets their event
      // subscriptions attach before create/resume returns to the caller.
      await Promise.resolve();
      this.processInteractions(subscription, pending);
      return subscription;
    } catch (error) {
      this.detachSession(sessionId);
      throw error;
    }
  }

  private ensureAgent(
    subscription: V2SessionSubscription,
    agentId: string,
  ): Promise<V2AgentSubscription> {
    const normalized = normalizeAgentId(agentId);
    const existing = subscription.agents.get(normalized);
    if (existing !== undefined) {
      return existing.ready.then(() => existing);
    }

    const entry: V2AgentSubscription = {
      handle: subscription.handle.agent(normalized),
      disposables: [],
      ready: Promise.resolve(),
    };
    subscription.agents.set(normalized, entry);
    entry.ready = this.initializeAgent(subscription, normalized, entry).catch((error) => {
      subscription.agents.delete(normalized);
      throw error;
    });
    return entry.ready.then(() => entry);
  }

  private async initializeAgent(
    subscription: V2SessionSubscription,
    agentId: string,
    entry: V2AgentSubscription,
  ): Promise<void> {
    // Materialize the main agent (or verify a subagent) before registering the
    // async memory-channel listener, then yield once so it is attached before
    // the first prompt can publish turn.started.
    await entry.handle.getPermission();
    if (!subscription.active) return;

    entry.disposables.push(
      entry.handle.events.onError((error) => {
        this.reportSubscriptionError(subscription, `agent "${agentId}" event stream`, error);
      }),
    );
    for (const eventName of FORWARDED_AGENT_EVENT_NAMES) {
      entry.disposables.push(
        entry.handle.events.on(eventName, (event) => {
          this.forwardAgentEvent(subscription, agentId, event);
        }),
      );
    }
    await Promise.resolve();
  }

  private forwardAgentEvent(
    subscription: V2SessionSubscription,
    agentId: string,
    payload: AgentEventPayloads[ForwardedAgentEventName],
  ): void {
    if (!subscription.active) return;
    let projectedPayload: object;
    try {
      projectedPayload = projectAgentEventPayload(payload);
    } catch (error) {
      this.reportSubscriptionError(
        subscription,
        `agent "${agentId}" event projection`,
        error,
      );
      return;
    }
    const parsed = eventSchema.safeParse({
      ...projectedPayload,
      sessionId: subscription.id,
      agentId,
    });
    if (!parsed.success) {
      this.reportSubscriptionError(
        subscription,
        `agent "${agentId}" event projection`,
        parsed.error,
      );
      return;
    }

    if (
      parsed.data.type === 'subagent.spawned' &&
      'subagentId' in parsed.data &&
      typeof parsed.data.subagentId === 'string'
    ) {
      const subagentId = parsed.data.subagentId;
      void this.ensureAgent(subscription, subagentId).catch((error: unknown) => {
        this.reportSubscriptionError(
          subscription,
          `subagent "${subagentId}" event stream`,
          error,
        );
      });
    }
    this.callbacks.emitEvent(parsed.data);
  }

  private async forwardMetadataChange(
    subscription: V2SessionSubscription,
    changed: readonly string[],
  ): Promise<void> {
    try {
      const metadata = await subscription.handle.get();
      if (!subscription.active) return;
      const patch: Record<string, unknown> = {};
      for (const key of changed) {
        if (!Object.hasOwn(metadata, key)) continue;
        const value = metadata[key as keyof typeof metadata];
        if (value !== undefined) patch[key] = value;
      }
      this.callbacks.emitEvent({
        type: 'session.meta.updated',
        sessionId: subscription.id,
        agentId: 'main',
        title: metadata.title,
        patch,
      });
    } catch (error) {
      this.reportSubscriptionError(subscription, 'session metadata projection', error);
    }
  }

  private processInteractions(
    subscription: V2SessionSubscription,
    interactions: readonly Interaction[],
  ): void {
    if (!subscription.active) return;
    for (const interaction of interactions) {
      if (
        interaction.kind === 'user_tool' ||
        subscription.processingInteractions.has(interaction.id)
      ) {
        continue;
      }
      subscription.processingInteractions.add(interaction.id);
      void this.processInteraction(subscription, interaction).finally(() => {
        subscription.processingInteractions.delete(interaction.id);
      });
    }
  }

  private async processInteraction(
    subscription: V2SessionSubscription,
    interaction: Interaction,
  ): Promise<void> {
    try {
      const response =
        interaction.kind === 'approval'
          ? await this.resolveApproval(subscription, interaction)
          : await this.resolveQuestion(subscription, interaction);
      if (!subscription.active) return;
      await subscription.handle.interactions.respond(interaction.id, response);
    } catch (error) {
      this.reportSubscriptionError(
        subscription,
        `${interaction.kind} interaction "${interaction.id}"`,
        error,
      );
    }
  }

  private async resolveApproval(
    subscription: V2SessionSubscription,
    interaction: Interaction,
  ): Promise<ApprovalResponse> {
    const parsed = SDK_APPROVAL_REQUEST_SCHEMA.safeParse(interaction.payload);
    if (!parsed.success) {
      this.reportSubscriptionError(subscription, 'approval request validation', parsed.error);
      return {
        decision: 'cancelled',
        feedback: 'Invalid approval request received from the runtime.',
      };
    }
    const agentId = normalizeAgentId(
      interaction.origin.agentId ?? parsed.data.agentId ?? 'main',
    );
    return this.callbacks.requestApproval({
      ...parsed.data,
      id: interaction.id,
      sessionId: subscription.id,
      agentId,
      turnId: parsed.data.turnId ?? interaction.origin.turnId,
    });
  }

  private async resolveQuestion(
    subscription: V2SessionSubscription,
    interaction: Interaction,
  ): Promise<QuestionResult> {
    const parsed = questionRequestSchema.safeParse(interaction.payload);
    if (!parsed.success) {
      this.reportSubscriptionError(subscription, 'question request validation', parsed.error);
      return null;
    }
    const agentId = normalizeAgentId(interaction.origin.agentId ?? 'main');
    return this.callbacks.requestQuestion({
      ...parsed.data,
      id: interaction.id,
      sessionId: subscription.id,
      agentId,
      turnId: parsed.data.turnId ?? interaction.origin.turnId,
    });
  }

  private reportSubscriptionError(
    subscription: V2SessionSubscription,
    source: string,
    error: unknown,
  ): void {
    if (!subscription.active) return;
    try {
      this.callbacks.emitEvent({
        type: 'error',
        sessionId: subscription.id,
        agentId: 'main',
        ...makeErrorPayload(
          ErrorCodes.REQUEST_INVALID,
          `${source}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
    } catch {
      // A consumer event-listener failure must not tear down the runtime
      // subscription or strand a pending interaction.
    }
  }

  private attachGlobalEvents(runtime: KimiV2Runtime): void {
    if (this.state !== 'open' || this.globalDisposables.length > 0) return;
    this.globalDisposables.push(
      runtime.klient.events.on('kosong.changed', (payload) => {
        if (this.state !== 'open') return;
        this.callbacks.emitEvent(projectModelCatalogChangedEvent(payload));
      }),
    );
  }

  private detachSession(sessionId: string): void {
    const subscription = this.subscriptions.get(sessionId);
    if (subscription === undefined) return;
    this.subscriptions.delete(sessionId);
    subscription.active = false;
    for (const agent of subscription.agents.values()) {
      for (const disposable of agent.disposables.splice(0)) disposable.dispose();
    }
    subscription.agents.clear();
    for (const disposable of subscription.disposables.splice(0)) disposable.dispose();
    subscription.processingInteractions.clear();
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state = 'closing';
    this.closePromise = (async () => {
      await this.waitForIdle();
      try {
        const runtime = await this.runtimeReady;
        for (const disposable of this.globalDisposables.splice(0)) {
          disposable.dispose();
        }
        for (const sessionId of this.subscriptions.keys()) {
          this.detachSession(sessionId);
        }
        await runtime.close();
      } finally {
        this.diagnosticLogRegistration.dispose();
        this.subscriptions.clear();
        this.sessions.clear();
        this.state = 'closed';
      }
    })();
    return this.closePromise;
  }

  private async run<T>(operation: (runtime: KimiV2Runtime) => Promise<T>): Promise<T> {
    if (this.state !== 'open') {
      throw new KimiError(ErrorCodes.SESSION_CLOSED, 'The SDK v2 runtime is closing or closed.');
    }

    this.activeCalls += 1;
    try {
      const runtime = await this.runtimeReady;
      return await operation(runtime);
    } catch (error) {
      throw mapV2BoundaryError(error);
    } finally {
      this.activeCalls -= 1;
      if (this.activeCalls === 0) {
        for (const resolveIdle of this.idleWaiters.splice(0)) {
          resolveIdle();
        }
      }
    }
  }

  private waitForIdle(): Promise<void> {
    if (this.activeCalls === 0) return Promise.resolve();
    return new Promise((resolveIdle) => {
      this.idleWaiters.push(resolveIdle);
    });
  }
}

export interface SDKRpcClientOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly autoLoadConfig?: boolean;
  readonly identity?: KimiHostIdentity;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  /**
   * Host UI mode (`'print'` for `kimi -p`, `'cli'` for the TUI, ...).
   * Print mode applies the v2 runtime's in-memory headless defaults.
   */
  readonly uiMode?: string;
}

export class SDKRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly core: V2CoreAdapter;

  private closePromise: Promise<void> | undefined;

  constructor(options: SDKRpcClientOptions = {}) {
    super();
    if (options.autoLoadConfig === false) {
      throw unsupportedV2Option(
        'autoLoadConfig',
        'The v2 hosted runtime always loads its config before exposing services.',
      );
    }
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    const requestHeaders = this.createKimiRequestHeaders();
    this.core = new V2CoreAdapter(
      {
        homeDir: this.homeDir,
        configPath: this.configPath,
        clientVersion: this.identity?.version,
        requestHeaders,
        skillDirs: options.skillDirs,
        mode: options.uiMode === 'print' ? 'print' : 'default',
      },
      requestHeaders,
      {
        emitEvent: (event) => {
          this.receiveEvent(event);
        },
        requestApproval: (request) => this.requestApproval(request),
        requestQuestion: (request) => this.requestQuestion(request),
      },
    );
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    return this.core.createSession(input);
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    return this.core.resumeSession(input);
  }

  override async reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    return this.core.reloadSession(input);
  }

  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    return this.core.forkSession(input);
  }

  override async deleteSession(input: { readonly sessionId: string }): Promise<void> {
    return this.core.deleteSession(input.sessionId);
  }

  override async renameSession(input: RenameSessionInput): Promise<void> {
    return this.core.renameSession(input);
  }

  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    return this.core.prompt(
      input.sessionId,
      this.interactiveAgentId,
      input.input,
      input.disabledTools,
    );
  }

  override async steer(input: SessionPromptRpcInput): Promise<void> {
    return this.core.steer(input.sessionId, this.interactiveAgentId, input.input);
  }

  override async cancel(input: { readonly sessionId: string }): Promise<void> {
    return this.core.cancel(input.sessionId, this.interactiveAgentId);
  }

  override async getStatus(input: { readonly sessionId: string }): Promise<SessionStatus> {
    return this.core.getStatus(input.sessionId, this.interactiveAgentId);
  }

  override async runShellCommand(input: {
    readonly sessionId: string;
    readonly command: string;
    readonly commandId?: string;
  }): Promise<ShellCommandResult> {
    return this.core.runShellCommand(input.sessionId, this.interactiveAgentId, {
      command: input.command,
      commandId: input.commandId,
    });
  }

  override async cancelShellCommand(input: {
    readonly sessionId: string;
    readonly commandId: string;
  }): Promise<void> {
    return this.core.cancelShellCommand(
      input.sessionId,
      this.interactiveAgentId,
      input.commandId,
    );
  }

  override async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    return this.core.generateAgentsMd(input.sessionId);
  }

  override async getSessionWarnings(input: SessionIdRpcInput) {
    return this.core.getSessionWarnings(input.sessionId);
  }

  override async addAdditionalDir(
    input: AddAdditionalDirInput,
  ): Promise<AddAdditionalDirResult> {
    return this.core.addAdditionalDir(input.id, {
      path: input.path,
      persist: input.persist,
    });
  }

  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    return this.core.startBtw(input.sessionId);
  }

  override async clearContext(input: SessionIdRpcInput): Promise<void> {
    return this.core.clearContext(input.sessionId, this.interactiveAgentId);
  }

  override async importContext(input: ImportContextRpcInput): Promise<void> {
    return this.core.importContext(
      input.sessionId,
      this.interactiveAgentId,
      {
        content: input.content,
        source: input.source,
      },
    );
  }

  override async setModel(
    input: SetSessionModelRpcInput,
  ): Promise<SetSessionModelRpcResult> {
    return this.core.setModel(
      input.sessionId,
      this.interactiveAgentId,
      input.model,
    );
  }

  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    return this.core.setThinking(
      input.sessionId,
      this.interactiveAgentId,
      input.effort,
    );
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    return this.core.setPermission(
      input.sessionId,
      this.interactiveAgentId,
      input.mode,
    );
  }

  override async updateSessionMetadata(
    input: UpdateSessionMetadataRpcInput,
  ): Promise<void> {
    return this.core.updateSessionMetadata(input.sessionId, input.metadata);
  }

  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    return this.core.setPlanMode(
      input.sessionId,
      this.interactiveAgentId,
      input.enabled,
    );
  }

  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    return this.core.setSwarmMode(
      input.sessionId,
      this.interactiveAgentId,
      input,
    );
  }

  override async swarm(input: SessionPromptRpcInput): Promise<void> {
    return this.core.swarm(
      input.sessionId,
      this.interactiveAgentId,
      input.input,
      input.disabledTools,
    );
  }

  override async getPlan(input: SessionIdRpcInput): Promise<SessionPlan> {
    return this.core.getPlan(input.sessionId, this.interactiveAgentId);
  }

  override async clearPlan(input: SessionIdRpcInput): Promise<void> {
    return this.core.clearPlan(input.sessionId, this.interactiveAgentId);
  }

  override async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    return this.core.compact(input.sessionId, this.interactiveAgentId, {
      instruction: input.instruction,
    });
  }

  override async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    return this.core.cancelCompaction(input.sessionId, this.interactiveAgentId);
  }

  override async undoHistory(
    input: SessionIdRpcInput & { readonly count: number },
  ): Promise<void> {
    return this.core.undoHistory(
      input.sessionId,
      this.interactiveAgentId,
      input.count,
    );
  }

  override async getContext(input: SessionIdRpcInput) {
    return this.core.getContext(input.sessionId, this.interactiveAgentId);
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    return this.core.getUsage(input.sessionId, this.interactiveAgentId);
  }

  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    return this.core.listSkills(input.sessionId);
  }

  override async listPluginCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly PluginCommandDef[]> {
    return this.core.listPluginCommands(input.sessionId);
  }

  override async listExpertTeams(
    input: SessionIdRpcInput,
  ): Promise<readonly ExpertTeamDefinition[]> {
    return this.core.listExpertTeams(input.sessionId);
  }

  override async getExpertTeam(
    input: SessionIdRpcInput,
  ): Promise<ExpertTeamSnapshot | null> {
    return this.core.getExpertTeam(input.sessionId);
  }

  override async getExpertTeamStatus(
    input: SessionIdRpcInput,
  ): Promise<ExpertTeamStatusSnapshot | null> {
    return this.core.getExpertTeamStatus(input.sessionId);
  }

  override async activateExpertTeam(
    input: ActivateExpertTeamRpcInput,
  ): Promise<ExpertTeamSnapshot> {
    return this.core.activateExpertTeam(input.sessionId, input.pluginId);
  }

  override async deactivateExpertTeam(input: SessionIdRpcInput): Promise<void> {
    return this.core.deactivateExpertTeam(input.sessionId);
  }

  override async listExtensionCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly ExtensionCommandDef[]> {
    return this.core.listExtensionCommands(input.sessionId);
  }

  override async activateExtensionCommand(
    input: ActivateExtensionCommandRpcInput,
  ): Promise<{ prompt?: string } | undefined> {
    return this.core.activateExtensionCommand(
      input.sessionId,
      this.interactiveAgentId,
      {
        name: input.name,
        args: input.args,
      },
    );
  }

  override async getCronTasks(
    input: SessionIdRpcInput,
  ): Promise<GetCronTasksResult> {
    return this.core.getCronTasks(input.sessionId);
  }

  override async listBackgroundTasks(
    input: SessionIdRpcInput & {
      readonly activeOnly?: boolean;
      readonly limit?: number;
    },
  ): Promise<readonly BackgroundTaskInfo[]> {
    return this.core.listBackgroundTasks(
      input.sessionId,
      this.interactiveAgentId,
      {
        activeOnly: input.activeOnly,
        limit: input.limit,
      },
    );
  }

  override async getBackgroundTaskOutput(
    input: SessionIdRpcInput & {
      readonly taskId: string;
      readonly tail?: number;
    },
  ): Promise<string> {
    return this.core.getBackgroundTaskOutput(
      input.sessionId,
      this.interactiveAgentId,
      {
        taskId: input.taskId,
        tail: input.tail,
      },
    );
  }

  override async stopBackgroundTask(
    input: SessionIdRpcInput & {
      readonly taskId: string;
      readonly reason?: string;
    },
  ): Promise<void> {
    return this.core.stopBackgroundTask(
      input.sessionId,
      this.interactiveAgentId,
      {
        taskId: input.taskId,
        reason: input.reason,
      },
    );
  }

  override async detachBackgroundTask(
    input: SessionIdRpcInput & { readonly taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    return this.core.detachBackgroundTask(
      input.sessionId,
      this.interactiveAgentId,
      input.taskId,
    );
  }

  override async waitForBackgroundTasksOnPrint(
    input: SessionIdRpcInput,
  ): Promise<void> {
    return this.core.waitForBackgroundTasksOnPrint(input.sessionId);
  }

  override async handlePrintMainTurnCompleted(
    input: SessionIdRpcInput,
  ): Promise<'finish' | 'continue'> {
    return this.core.handlePrintMainTurnCompleted(input.sessionId);
  }

  override async createGoal(
    input: SessionIdRpcInput & CreateGoalInput,
  ): Promise<GoalSnapshot> {
    return this.core.createGoal(input.sessionId, this.interactiveAgentId, {
      objective: input.objective,
      replace: input.replace,
    });
  }

  override async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    return this.core.getGoal(input.sessionId, this.interactiveAgentId);
  }

  override async pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    return this.core.pauseGoal(input.sessionId, this.interactiveAgentId);
  }

  override async resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    return this.core.resumeGoal(input.sessionId, this.interactiveAgentId);
  }

  override async cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    return this.core.cancelGoal(input.sessionId, this.interactiveAgentId);
  }

  override async listMcpServers(
    input: SessionIdRpcInput,
  ): Promise<readonly McpServerInfo[]> {
    return this.core.listMcpServers(input.sessionId);
  }

  override async getMcpStartupMetrics(
    input: SessionIdRpcInput,
  ): Promise<McpStartupMetrics> {
    return this.core.getMcpStartupMetrics(input.sessionId);
  }

  override async reconnectMcpServer(
    input: ReconnectMcpServerRpcInput,
  ): Promise<void> {
    return this.core.reconnectMcpServer(input.sessionId, input.name);
  }

  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return this.core.listPlugins();
  }

  override async installPlugin(source: string): Promise<PluginSummary> {
    return this.core.installPlugin(source);
  }

  override async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    return this.core.setPluginEnabled(id, enabled);
  }

  override async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    return this.core.setPluginMcpServerEnabled(id, server, enabled);
  }

  override async removePlugin(id: string): Promise<void> {
    return this.core.removePlugin(id);
  }

  override async reloadPlugins(): Promise<ReloadSummary> {
    return this.core.reloadPlugins();
  }

  override async getPluginInfo(id: string): Promise<PluginInfo> {
    return this.core.getPluginInfo(id);
  }

  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    return this.core.activateSkill(
      input.sessionId,
      this.interactiveAgentId,
      {
        name: input.name,
        args: input.args,
      },
    );
  }

  override async activatePluginCommand(
    input: ActivatePluginCommandRpcInput,
  ): Promise<void> {
    return this.core.activatePluginCommand(
      input.sessionId,
      this.interactiveAgentId,
      {
        pluginId: input.pluginId,
        commandName: input.commandName,
        args: input.args,
      },
    );
  }

  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    return this.core.exportSession(input);
  }

  override async listSessions(
    input: ListSessionsOptions = {},
  ): Promise<readonly SessionSummary[]> {
    return this.core.listSessions(input);
  }

  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    return this.core.listWorkspaceSkills(workDir);
  }

  override async getConfig(input: GetConfigOptions = {}): Promise<KimiConfig> {
    return this.core.getConfig(input);
  }

  override async setConfig(input: KimiConfigPatch): Promise<KimiConfig> {
    return this.core.setConfig(input);
  }

  override async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    return this.core.getConfigDiagnostics();
  }

  override async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.core.getExperimentalFeatures();
  }

  override async removeProvider(providerId: string): Promise<KimiConfig> {
    return this.core.removeProvider(providerId);
  }

  override async listGlobalMcpServers(): Promise<readonly McpServerConfig[]> {
    return this.core.listGlobalMcpServers();
  }

  override async addGlobalMcpServer(
    server: McpServerConfig,
  ): Promise<readonly McpServerConfig[]> {
    return this.core.addGlobalMcpServer(server);
  }

  override async updateGlobalMcpServer(
    server: McpServerConfig,
  ): Promise<readonly McpServerConfig[]> {
    return this.core.updateGlobalMcpServer(server);
  }

  override async removeGlobalMcpServer(
    name: string,
  ): Promise<readonly McpServerConfig[]> {
    return this.core.removeGlobalMcpServer(name);
  }

  override async beginGlobalMcpServerAuth(
    name: string,
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.core.beginGlobalMcpServerAuth(name);
  }

  override async completeGlobalMcpServerAuth(
    input: { readonly flowId: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.core.completeGlobalMcpServerAuth(input, signal);
  }

  override async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    return this.core.cancelGlobalMcpServerAuth(flowId);
  }

  override async resetGlobalMcpServerAuth(name: string): Promise<void> {
    return this.core.resetGlobalMcpServerAuth(name);
  }

  override async testGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return this.core.testGlobalMcpServer(name, options);
  }

  override async closeSession(input: { readonly sessionId: string }): Promise<void> {
    await this.core.closeSession(input.sessionId);
  }

  override async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    return this.core.createSessionWithOverrides(input, { kaos, persistenceKaos });
  }

  override async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    return this.core.resumeSessionWithOverrides(input, { kaos, persistenceKaos });
  }

  protected async getRpc(): Promise<ResolvedCoreAPI> {
    await this.core.whenReady();
    const { mapped } = getV2CompatibilityMethodReport();
    throw unsupportedV2Method(
      'legacy root SDK RPC operation',
      `Mapped methods: ${mapped.join(', ')}.`,
    );
  }

  private async closeOnce(): Promise<void> {
    try {
      await flushDiagnosticLogs();
    } catch {
      // Logger shutdown must not prevent the runtime from being released.
    }
    await this.core.close();
  }

  private createKimiRequestHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir: this.homeDir,
      ...this.identity,
    });
  }
}

const ROOT_SDK_NON_RPC_ASYNC_METHODS = new Set([
  'createSessionWithKaos',
  'enterSwarmMode',
  'exitSwarmMode',
  'resumeSessionWithKaos',
  'requestApproval',
  'requestQuestion',
  'toolCall',
]);

/**
 * Derives compatibility coverage from the actual base methods and concrete
 * overrides so error diagnostics and coverage tests cannot drift from the
 * implementation.
 */
export function getV2CompatibilityMethodReport(): {
  readonly mapped: readonly string[];
  readonly unmapped: readonly string[];
} {
  const compatibilityMethods = asyncPrototypeMethodNames(
    SDKRpcClientBase.prototype,
  ).filter((name) => !ROOT_SDK_NON_RPC_ASYNC_METHODS.has(name));
  const overrides = new Set(Object.getOwnPropertyNames(SDKRpcClient.prototype));
  return {
    mapped: compatibilityMethods.filter((name) => overrides.has(name)).toSorted(),
    unmapped: compatibilityMethods
      .filter((name) => !overrides.has(name))
      .toSorted(),
  };
}

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClient(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: rpc.core.imageLimits,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}

function asyncPrototypeMethodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    const value = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    return (
      typeof value === 'function' &&
      Object.prototype.toString.call(value) === '[object AsyncFunction]'
    );
  });
}

function unsupportedV2Method(method: string, reason: string): KimiError {
  const { mapped, unmapped } = getV2CompatibilityMethodReport();
  return new KimiError(
    ErrorCodes.NOT_IMPLEMENTED,
    `${method} is not mapped by the v2-backed root SDK compatibility layer. ${reason}`,
    { details: { mappedMethods: mapped, unmappedMethods: unmapped } },
  );
}

export {
  projectAgentEventPayload,
  projectCronTasks,
  projectExpertTeamChangedEvent,
  projectExpertTeamStatus,
  projectModelCatalogChangedEvent,
};
