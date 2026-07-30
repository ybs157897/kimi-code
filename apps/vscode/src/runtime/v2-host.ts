import type {
  AgentContextData,
  AgentEventPayloads,
  Klient,
  McpCatalogEntry,
  McpProbeResult,
  ResumedAgentState,
  SkillSummary,
} from "@moonshot-ai/klient";
import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  JsonObject,
  KimiConfig,
  McpServerConfig,
  PermissionMode,
  PromptInput,
  QuestionRequest,
  QuestionResult,
  ResumedSessionState,
  SessionStatus,
} from "@moonshot-ai/kimi-code-sdk";
import type { KimiV2Runtime } from "@moonshot-ai/kimi-code-sdk/v2";

type CoreMcpServerConfig = McpCatalogEntry["config"];
const VSCODE_ADDITIONAL_DIRS_METADATA_KEY = "vscode_additional_dirs";

export interface VscodeSessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean;
  readonly metadata?: JsonObject;
  readonly additionalDirs?: readonly string[];
}

export interface VscodeSessionPort {
  readonly id: string;
  readonly workDir: string;
  readonly summary?: VscodeSessionSummary;
  prompt(input: string | PromptInput): Promise<void>;
  steer(input: string | PromptInput): Promise<void>;
  cancel(): Promise<void>;
  compact(options?: { readonly instruction?: string }): Promise<void>;
  cancelCompaction(): Promise<void>;
  close(): Promise<void>;
  getStatus(): Promise<SessionStatus>;
  setModel(model: string): Promise<unknown>;
  setThinking(effort: string): Promise<void>;
  setPermission(permission: PermissionMode): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  getPlan(): Promise<{ readonly id: string; readonly content: string; readonly path: string } | null>;
  clearPlan(): Promise<void>;
  clearContext(): Promise<void>;
  getContext(): Promise<AgentContextData>;
  importContext(content: string, source: string): Promise<void>;
  init(): Promise<void>;
  activateSkill(name: string, args?: string): Promise<void>;
  addAdditionalDir(
    path: string,
    options?: { readonly persist?: boolean },
  ): Promise<{ readonly projectRoot: string; readonly additionalDirs: readonly string[] }>;
  updateMetadata(patch: Readonly<Record<string, unknown>>): Promise<void>;
  getResumeState():
    | ResumedSessionState
    | undefined
    | Promise<ResumedSessionState | undefined>;
  setApprovalHandler(
    handler: ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) | undefined,
  ): void;
  setQuestionHandler(
    handler: ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>) | undefined,
  ): void;
  onEvent(listener: (event: Event) => void): () => void;
  listSkills(): ReturnType<ReturnType<Klient["session"]>["skills"]["list"]>;
}

export interface VscodeSessionHostPort {
  createSession(input: {
    readonly workDir: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly permission?: PermissionMode;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<VscodeSessionPort>;
  resumeSession(input: { readonly id: string }): Promise<VscodeSessionPort>;
  closeSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface VscodeHostPort extends VscodeSessionHostPort {
  readonly homeDir: string;
  getConfig(options?: { readonly reload?: boolean }): Promise<KimiConfig>;
  setConfig(patch: Readonly<Record<string, unknown>>): Promise<void>;
  reloadConfig(): Promise<void>;
  listSessions(input?: {
    readonly workDir?: string;
    readonly sessionId?: string;
  }): Promise<readonly VscodeSessionSummary[]>;
  listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]>;
  forkSession(input: { readonly id: string; readonly turnIndex?: number }): Promise<VscodeSessionPort>;
  isAuthenticated(): Promise<boolean>;
  login(onAuthorizationUrl: (url: string) => void | Promise<void>): Promise<void>;
  logout(): Promise<void>;
  listMcpServers(): Promise<readonly McpServerConfig[]>;
  addMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]>;
  updateMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]>;
  removeMcpServer(name: string): Promise<readonly McpServerConfig[]>;
  authenticateMcpServer(
    name: string,
    options: { readonly onAuthorizationUrl: (url: string) => void | Promise<void> },
  ): Promise<void>;
  resetMcpServerAuth(name: string): Promise<void>;
  testMcpServer(name: string, options?: { readonly cwd?: string }): Promise<{
    readonly success: boolean;
    readonly output: string;
  }>;
}

export class VscodeV2Host implements VscodeHostPort {
  constructor(
    private readonly runtimePromise: Promise<KimiV2Runtime>,
    readonly homeDir: string,
  ) {}

  async createSession(input: Parameters<VscodeSessionHostPort["createSession"]>[0]) {
    const runtime = await this.runtimePromise;
    const created = await runtime.hostedSessions.create({
      workDir: input.workDir,
      metadata: input.metadata,
    });
    const session = await VscodeV2Session.open(runtime.klient, created.id);
    if (input.model !== undefined) await session.setModel(input.model);
    if (input.thinking !== undefined) await session.setThinking(input.thinking);
    if (input.permission !== undefined) await session.setPermission(input.permission);
    return session;
  }

  async resumeSession(input: { readonly id: string }): Promise<VscodeSessionPort> {
    const runtime = await this.runtimePromise;
    const resumed = await runtime.hostedSessions.resume(input.id);
    if (resumed === undefined) throw new Error(`Session "${input.id}" was not found.`);
    return VscodeV2Session.open(runtime.klient, resumed.id);
  }

  async closeSession(id: string): Promise<void> {
    const runtime = await this.runtimePromise;
    await runtime.klient.session(id).close();
  }

  async deleteSession(id: string): Promise<void> {
    const runtime = await this.runtimePromise;
    const summary = await runtime.klient.global.sessions.get(id);
    if (summary === undefined) return;
    await runtime.klient.global.sessionStore.delete({
      workspaceId: summary.workspaceId,
      sessionId: id,
    });
  }

  async close(): Promise<void> {
    const runtime = await this.runtimePromise;
    await runtime.close();
  }

  async getConfig(options?: { readonly reload?: boolean }): Promise<KimiConfig> {
    const klient = (await this.runtimePromise).klient;
    if (options?.reload === true) await klient.global.config.reload();
    const [models, defaultModel, thinking] = await Promise.all([
      klient.global.config.get<KimiConfig["models"]>("models"),
      klient.global.config.get<string | undefined>("defaultModel"),
      klient.global.config.get<KimiConfig["thinking"]>("thinking"),
    ]);
    return { models, defaultModel, thinking };
  }

  async setConfig(patch: Readonly<Record<string, unknown>>): Promise<void> {
    const klient = (await this.runtimePromise).klient;
    const defaultModel = patch["defaultModel"];
    if (typeof defaultModel === "string") {
      await klient.global.kosong.setDefaultModel(defaultModel);
    }
    const thinking = patch["thinking"];
    if (thinking !== undefined) {
      await klient.global.config.set({ domain: "thinking", patch: thinking });
    }
  }

  async reloadConfig(): Promise<void> {
    await (await this.runtimePromise).klient.global.config.reload();
  }

  async listSessions(input: {
    readonly workDir?: string;
    readonly sessionId?: string;
  } = {}): Promise<readonly VscodeSessionSummary[]> {
    const klient = (await this.runtimePromise).klient;
    const workspaces = await klient.global.workspaces.list();
    const roots = new Map(workspaces.map((workspace) => [workspace.id, workspace.root]));
    const workspaceIds = input.workDir === undefined
      ? undefined
      : workspaces
          .filter((workspace) => workspace.root === input.workDir)
          .map((workspace) => workspace.id);
    if (workspaceIds !== undefined && workspaceIds.length === 0) return [];

    const result: VscodeSessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await klient.global.sessions.list({
        workspaceIds,
        sessionId: input.sessionId,
        cursor,
        limit: 100,
      });
      for (const summary of page.items) {
        const workDir = summary.cwd ?? roots.get(summary.workspaceId);
        if (workDir === undefined) {
          throw new Error(`Workspace "${summary.workspaceId}" is unavailable.`);
        }
        result.push({
          id: summary.id,
          workDir,
          title: summary.title,
          lastPrompt: summary.lastPrompt,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          archived: summary.archived,
          metadata: summary.custom as JsonObject | undefined,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }

  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    return (await this.runtimePromise).klient.global.skills.listWorkspace(workDir);
  }

  async forkSession(input: {
    readonly id: string;
    readonly turnIndex?: number;
  }): Promise<VscodeSessionPort> {
    const runtime = await this.runtimePromise;
    const source = await runtime.klient.global.sessions.get(input.id);
    if (source === undefined) throw new Error(`Session "${input.id}" was not found.`);
    const forked = await runtime.klient.session(input.id).fork({
      userVisibleTurnIndex: input.turnIndex,
    });
    const resumed = await runtime.hostedSessions.resume(forked.id);
    if (resumed === undefined) throw new Error(`Forked session "${forked.id}" is unavailable.`);
    return VscodeV2Session.open(runtime.klient, resumed.id);
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.runtimePromise).klient.global.auth.status().then((status) => status.loggedIn);
  }

  async login(onAuthorizationUrl: (url: string) => void | Promise<void>): Promise<void> {
    const auth = (await this.runtimePromise).klient.global.auth;
    const started = await auth.startLogin();
    if (started.status === "authenticated") return;
    await onAuthorizationUrl(started.verification_uri_complete || started.verification_uri);
    while (true) {
      const flow = await auth.flow(started.provider);
      if (flow?.status === "authenticated") return;
      if (flow !== undefined && flow.status !== "pending") {
        throw new Error(flow.error_message ?? `Login ${flow.status}.`);
      }
      await delay(Math.max(250, started.interval * 1000));
    }
  }

  async logout(): Promise<void> {
    await (await this.runtimePromise).klient.global.auth.logout();
  }

  async listMcpServers(): Promise<readonly McpServerConfig[]> {
    return (await this.mcpEntries()).map(toNamedMcpServer);
  }

  async addMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    const { name, config } = splitNamedMcpServer(server);
    await (await this.runtimePromise).klient.global.mcp.catalog.add({ name, config });
    return this.listMcpServers();
  }

  async updateMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    const { name, config } = splitNamedMcpServer(server);
    await (await this.runtimePromise).klient.global.mcp.catalog.update({ name, config });
    return this.listMcpServers();
  }

  async removeMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    await (await this.runtimePromise).klient.global.mcp.catalog.remove(name);
    return this.listMcpServers();
  }

  async authenticateMcpServer(
    name: string,
    options: { readonly onAuthorizationUrl: (url: string) => void | Promise<void> },
  ): Promise<void> {
    const runtime = await this.runtimePromise;
    const entry = await runtime.klient.global.mcp.catalog.get(name);
    const url = entry?.config.transport === "http" || entry?.config.transport === "sse"
      ? entry.config.url
      : undefined;
    if (url === undefined) throw new Error(`MCP server "${name}" does not support OAuth.`);
    const flow = await runtime.klient.global.mcp.oauth.begin({ serverName: name, serverUrl: url });
    await options.onAuthorizationUrl(flow.authorizationUrl);
    await runtime.klient.global.mcp.oauth.complete({ flowId: flow.flowId });
  }

  async resetMcpServerAuth(name: string): Promise<void> {
    const runtime = await this.runtimePromise;
    const entry = await runtime.klient.global.mcp.catalog.get(name);
    const url = entry?.config.transport === "http" || entry?.config.transport === "sse"
      ? entry.config.url
      : undefined;
    if (url === undefined) throw new Error(`MCP server "${name}" does not support OAuth.`);
    await runtime.klient.global.mcp.oauth.invalidate({
      serverName: name,
      serverUrl: url,
      scope: "all",
    });
  }

  async testMcpServer(name: string, options?: { readonly cwd?: string }): Promise<{
    readonly success: boolean;
    readonly output: string;
  }> {
    const runtime = await this.runtimePromise;
    const entry = await runtime.klient.global.mcp.catalog.get(name);
    if (entry === undefined) throw new Error(`MCP server "${name}" was not found.`);
    return probeResult(
      await runtime.klient.global.mcp.probe.run({
        serverName: name,
        config: entry.config,
        cwd: options?.cwd,
      }),
    );
  }

  private async mcpEntries(): Promise<readonly McpCatalogEntry[]> {
    return (await this.runtimePromise).klient.global.mcp.catalog.list();
  }
}

class VscodeV2Session implements VscodeSessionPort {
  private approvalHandler:
    | ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>)
    | undefined;
  private questionHandler:
    | ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>)
    | undefined;
  private summaryValue: VscodeSessionSummary;

  private constructor(
    private readonly klient: Klient,
    readonly id: string,
    summary: VscodeSessionSummary,
  ) {
    this.summaryValue = summary;
  }

  static async open(klient: Klient, id: string): Promise<VscodeV2Session> {
    const [metadata, initialWorkspace] = await Promise.all([
      klient.session(id).get(),
      klient.session(id).workspace.get(),
    ]);
    const storedAdditionalDirs = readStringArray(
      metadata.custom?.[VSCODE_ADDITIONAL_DIRS_METADATA_KEY],
    );
    let additionalDirs = initialWorkspace.additionalDirs;
    for (const path of storedAdditionalDirs) {
      if (additionalDirs.includes(path)) continue;
      const result = await klient.session(id).workspace.addAdditionalDir({
        path,
        persist: false,
      });
      additionalDirs = result.additionalDirs;
    }
    return new VscodeV2Session(klient, id, {
      id,
      workDir: initialWorkspace.workDir,
      title: metadata.title,
      lastPrompt: metadata.lastPrompt,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      metadata: metadata.custom as JsonObject | undefined,
      additionalDirs,
    });
  }

  get workDir(): string {
    return this.summaryValue.workDir;
  }

  get summary(): VscodeSessionSummary {
    return this.summaryValue;
  }

  private get session() {
    return this.klient.session(this.id);
  }

  private get agent() {
    return this.session.agent("main");
  }

  async prompt(input: string | PromptInput): Promise<void> {
    await this.agent.prompt({ input: typeof input === "string" ? [{ type: "text", text: input }] : input });
  }

  async steer(input: string | PromptInput): Promise<void> {
    await this.agent.steer({ input: typeof input === "string" ? [{ type: "text", text: input }] : input });
  }

  async cancel(): Promise<void> {
    await this.agent.cancel();
  }

  async compact(options?: { readonly instruction?: string }): Promise<void> {
    await this.agent.compact(options);
  }

  async cancelCompaction(): Promise<void> {
    await this.agent.cancelCompaction();
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async getStatus(): Promise<SessionStatus> {
    const [model, thinking, permission, plan, context, usage, replay] = await Promise.all([
      this.agent.getModel(),
      this.agent.profile.get(),
      this.agent.getPermission(),
      this.agent.getPlan(),
      this.agent.getContext(),
      this.agent.getUsage(),
      this.agent.replay.read().catch(() => undefined),
    ]);
    const maxContextTokens = replay?.config.modelCapabilities?.max_context_tokens ?? 0;
    return {
      model,
      thinkingEffort: thinking.thinkingLevel,
      permission,
      planMode: plan !== null,
      contextTokens: context.tokenCount,
      maxContextTokens,
      contextUsage: maxContextTokens === 0 ? 0 : context.tokenCount / maxContextTokens,
      usage,
    };
  }

  setModel(model: string): Promise<unknown> {
    return this.agent.setModel(model);
  }

  setThinking(effort: string): Promise<void> {
    return this.agent.profile.setThinking(effort);
  }

  setPermission(permission: PermissionMode): Promise<void> {
    return this.agent.setPermission(permission);
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    await (enabled ? this.agent.enterPlan() : this.agent.cancelPlan());
  }

  getPlan() {
    return this.agent.getPlan();
  }

  clearPlan(): Promise<void> {
    return this.agent.clearPlan();
  }

  clearContext(): Promise<void> {
    return this.agent.clearContext();
  }

  getContext() {
    return this.agent.getContext();
  }

  importContext(content: string, source: string): Promise<void> {
    return this.agent.importContext({ content, source });
  }

  init(): Promise<void> {
    return this.session.init.generateAgentsMd();
  }

  activateSkill(name: string, args?: string): Promise<void> {
    return this.agent.skills.activate({ name, args });
  }

  async addAdditionalDir(
    path: string,
    options?: { readonly persist?: boolean },
  ): Promise<{ readonly projectRoot: string; readonly additionalDirs: readonly string[] }> {
    const result = await this.session.workspace.addAdditionalDir({
      path,
      persist: options?.persist,
    });
    if (options?.persist !== true) {
      const metadata = await this.session.get();
      await this.session.update({
        custom: {
          ...metadata.custom,
          [VSCODE_ADDITIONAL_DIRS_METADATA_KEY]: result.additionalDirs,
        },
      });
    }
    this.summaryValue = { ...this.summaryValue, additionalDirs: result.additionalDirs };
    return result;
  }

  async updateMetadata(patch: Readonly<Record<string, unknown>>): Promise<void> {
    const metadata = await this.session.get();
    const custom = { ...metadata.custom, ...patch };
    await this.session.update({ custom });
    this.summaryValue = {
      ...this.summaryValue,
      metadata: custom as JsonObject,
    };
  }

  async getResumeState(): Promise<ResumedSessionState> {
    const [metadata, agents] = await Promise.all([this.session.get(), this.session.agents()]);
    const agentIds = new Set(["main", ...Object.keys(agents)]);
    const states: Record<string, ResumedAgentState> = {};
    await Promise.all([...agentIds].map(async (agentId) => {
      try {
        const state = await this.session.agent(agentId).replay.read();
        states[agentId] = {
          ...state,
          config: { ...state.config, cwd: this.workDir },
        };
      } catch {
        // A persisted agent may not have replay state; omit it.
      }
    }));
    return {
      sessionMetadata: metadata,
      agents: states,
    } as ResumedSessionState;
  }

  setApprovalHandler(
    handler: ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) | undefined,
  ): void {
    this.approvalHandler = handler;
  }

  setQuestionHandler(
    handler: ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>) | undefined,
  ): void {
    this.questionHandler = handler;
  }

  onEvent(listener: (event: Event) => void): () => void {
    const disposables: Array<{ dispose(): void }> = [];
    const subscribedAgentIds = new Set<string>();
    const handledInteractionIds = new Set<string>();
    let disposed = false;

    const subscribeAgent = (agentId: string): void => {
      if (disposed || subscribedAgentIds.has(agentId)) return;
      subscribedAgentIds.add(agentId);
      const agent = this.session.agent(agentId);
      for (const name of AGENT_EVENT_NAMES) {
        disposables.push(agent.events.on(name, (payload) => {
          listener({ ...payload, sessionId: this.id, agentId } as Event);
          if (
            payload.type === "subagent.spawned" &&
            typeof payload.subagentId === "string"
          ) {
            subscribeAgent(payload.subagentId);
          }
        }));
      }
    };

    subscribeAgent("main");
    void this.session.agents()
      .then((agents) => {
        for (const agentId of Object.keys(agents)) subscribeAgent(agentId);
      })
      .catch(() => {
        // The main-agent stream remains usable if persisted agent discovery fails.
      });

    disposables.push(this.session.events.on("interactions.changed", (interactions) => {
      for (const interaction of interactions) {
        if (handledInteractionIds.has(interaction.id)) continue;
        if (interaction.kind === "approval" && this.approvalHandler !== undefined) {
          const request = asApprovalRequest(interaction.payload);
          if (request !== undefined) {
            handledInteractionIds.add(interaction.id);
            void Promise.resolve(this.approvalHandler(request))
              .then((response) => this.session.approvals.decide(interaction.id, response))
              .catch(() => {
                handledInteractionIds.delete(interaction.id);
              });
          }
        }
        if (interaction.kind === "question" && this.questionHandler !== undefined) {
          const request = asQuestionRequest(interaction.payload);
          if (request !== undefined) {
            handledInteractionIds.add(interaction.id);
            void Promise.resolve(this.questionHandler(request)).then((result) =>
              result === null
                ? this.session.questions.dismiss(interaction.id)
                : this.session.questions.answer(interaction.id, result),
            ).catch(() => {
              handledInteractionIds.delete(interaction.id);
            });
          }
        }
      }
    }));
    return () => {
      disposed = true;
      for (const disposable of disposables) disposable.dispose();
    };
  }

  listSkills() {
    return this.session.skills.list();
  }
}

const AGENT_EVENT_NAMES: readonly (keyof AgentEventPayloads)[] = [
  "turn.started", "turn.ended", "turn.step.started", "turn.step.retrying",
  "turn.step.interrupted", "turn.step.completed", "assistant.delta", "hook.result",
  "thinking.delta", "tool.call.delta", "tool.call.started", "tool.progress",
  "shell.output", "shell.started", "tool.result", "prompt.completed", "prompt.aborted",
  "goal.updated", "skill.activated", "plugin_command.activated",
  "permission.approval.requested", "permission.approval.resolved", "error", "warning",
  "notice", "agent.status.updated", "compaction.started", "compaction.blocked",
  "compaction.cancelled", "compaction.completed", "subagent.spawned", "subagent.started",
  "subagent.suspended", "subagent.completed", "subagent.failed", "task.started",
  "task.terminated", "cron.fired", "mcp.server.status", "tool.list.updated",
];

function asApprovalRequest(value: unknown): ApprovalRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value["toolName"] !== "string" ||
    typeof value["action"] !== "string" ||
    !isRecord(value["display"])
  ) return undefined;
  return value as unknown as ApprovalRequest;
}

function asQuestionRequest(value: unknown): QuestionRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value["questions"])) return undefined;
  return value as unknown as QuestionRequest;
}

function splitNamedMcpServer(server: McpServerConfig): {
  readonly name: string;
  readonly config: CoreMcpServerConfig;
} {
  const { name, ...config } = server;
  return { name, config: config as CoreMcpServerConfig };
}

function toNamedMcpServer(entry: McpCatalogEntry): McpServerConfig {
  const config = Object.fromEntries(
    Object.entries(entry.config).filter(([, value]) => value !== undefined),
  ) as CoreMcpServerConfig;
  return {
    name: entry.name,
    ...config,
  };
}

function probeResult(result: McpProbeResult): { readonly success: boolean; readonly output: string } {
  return {
    success: result.success,
    output: result.success
      ? `Connected. ${String(result.toolCount)} tool(s) available.`
      : result.error ?? "Connection failed.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
