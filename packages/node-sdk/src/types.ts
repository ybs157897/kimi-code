import type { Kaos } from '@moonshot-ai/kaos';
import type { KimiHostIdentity, OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { ContextMessage, PromptOrigin } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '@moonshot-ai/agent-core-v2/agent/goal/types';
import type { LoopControl } from '@moonshot-ai/agent-core-v2/agent/loop/configSection';
import type { McpServerConfig as CoreMcpServerConfig } from '@moonshot-ai/agent-core-v2/agent/mcp/config-schema';
import type { PermissionMode as PermissionModeV2 } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type {
  AgentReplayRecord,
  ResumedAgentState,
  ResumeSessionResult,
} from '@moonshot-ai/agent-core-v2/agent/replayBuilder/types';
import type {
  ConfigDiagnostics,
  McpServerInfo,
  McpStartupMetrics,
  SkillSummary as SkillSummaryV2,
} from '@moonshot-ai/agent-core-v2/agent/rpc/core-api';
import type { ServicesConfig } from '@moonshot-ai/agent-core-v2/app/auth/configSection';
import type {
  PluginCommandDef,
  PluginGithubMetadata,
  PluginGithubRef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSource,
  PluginSummary,
  ReloadSummary,
} from '@moonshot-ai/agent-core-v2/app/plugin/types';
import type {
  ExportSessionManifest,
  ShellEnvironment,
} from '@moonshot-ai/agent-core-v2/app/sessionExport/sessionExport';
import type { ThinkingConfig } from '@moonshot-ai/agent-core-v2/kosong/model/thinking';
import type {
  OAuthRef,
  ProviderConfig,
  ProviderType,
} from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import type {
  ExpertTeamDefinition,
  ExpertTeamSnapshot,
} from '@moonshot-ai/agent-core-v2/session/expertTeam/expertTeam';
import type { ToolInfo } from '@moonshot-ai/agent-core-v2/tool/toolContract';
import type {
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
} from '#/sdk-telemetry';

// ── Shared data types ────────────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

// ── v2-available types (imported from agent-core-v2 subpaths) ────────────

type SkillSummary = SkillSummaryV2;

export type {
  AgentReplayRecord,
  ConfigDiagnostics,
  ContextMessage,
  ExportSessionManifest,
  ExpertTeamDefinition,
  ExpertTeamSnapshot,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  LoopControl,
  McpServerInfo,
  McpStartupMetrics,
  OAuthRef,
  PluginCommandDef,
  PluginGithubMetadata,
  PluginGithubRef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSource,
  PluginSummary,
  ProviderConfig,
  ProviderType,
  ReloadSummary,
  ResumedAgentState,
  ResumeSessionResult,
  ServicesConfig,
  ShellEnvironment,
  SkillSummary,
  ThinkingConfig,
  ToolInfo,
  PromptOrigin,
};

export type PermissionMode = PermissionModeV2;

// ── Types defined locally (no v2 equivalent or shape differs) ────────────

export type AgentBackgroundTaskInfo = {
  readonly taskId: string;
  readonly kind: string;
  readonly status: string;
  readonly name?: string;
  readonly command?: string;
  readonly createdAt?: number;
  readonly agentId?: string;
  readonly exitCode?: number;
  readonly error?: string;
};

export type BackgroundConfig = {
  readonly printWaitCeilingS?: number;
  readonly keepAliveOnExit?: boolean;
  readonly printBackgroundMode?: string;
};

export type BackgroundTaskInfo = {
  readonly id: string;
  /** Deprecated alias for `id`, kept for consumers still referencing it. */
  readonly taskId?: string;
  readonly kind: string;
  readonly name?: string;
  readonly status?: string;
  readonly description?: string;
  readonly command?: string;
  readonly subagentType?: string;
  readonly stopReason?: string;
  readonly agentId?: string;
  readonly exitCode?: number;
};

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type CronTaskSnapshot = {
  readonly id: string;
  readonly name: string;
  readonly expression: string;
  readonly status: string;
  readonly nextRunAt?: number;
};

export type ExperimentalFeatureState = {
  readonly id: string;
  readonly enabled: boolean;
  readonly source?: string;
};

export type ExperimentalFlagMap = Record<string, boolean>;

export type ExperimentalFlagSource = 'env' | 'config' | 'builtin' | 'runtime';

export type ExpertTeamMemberPhase = {
  readonly phase: 'waiting' | 'active' | 'completed';
  readonly stepDescription?: string;
};

export type ExpertTeamMemberState = {
  readonly agentId: string;
  readonly phase: ExpertTeamMemberPhase;
  readonly goal?: string;
  readonly response?: string;
};

export type ExpertTeamStatusSnapshot = {
  readonly members: readonly ExpertTeamMemberState[];
  readonly agentId?: string;
};

export type ExtensionCommandDef = {
  readonly name: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly action?: string;
  readonly extensionId: string;
};

export type GetCronTasksResult = {
  readonly tasks: readonly CronTaskSnapshot[];
};

// `KimiConfig` / `ModelAlias` are owned by `sdk-config` (the SDK's single
// config-type source); `ProviderConfig` / `OAuthRef` are re-exported from the
// v2 engine above. Re-export them here so the historical `#/types` surface
// keeps naming them.
export type { KimiConfig, ModelAlias } from '#/sdk-config';

export type KimiConfigPatch = Record<string, unknown>;

/**
 * Compatibility shape used by the root SDK's user-global MCP facade.
 *
 * The v2 core owns the transport configuration, while the global catalog
 * keys that configuration by server name. The historical root SDK keeps the
 * name inline and preserves the OAuth UI marker accepted by existing hosts.
 */
export type McpServerConfig = CoreMcpServerConfig & {
  readonly name: string;
  readonly auth?: 'oauth';
};

export type McpTestResult = {
  readonly success: boolean;
  readonly output: string;
};

export type MoonshotServiceConfig = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
};

export type ProcessBackgroundTaskInfo = {
  readonly pid?: number;
  readonly command?: string;
};

export type QuestionBackgroundTaskInfo = {
  readonly question: string;
  readonly options?: readonly string[];
};

export type { KimiHostIdentity, OAuthRefreshOutcome };
export type { TelemetryClient, TelemetryContextPatch, TelemetryProperties };
export type { ContentPart, Role, ThinkingEffort, ToolCall } from '@moonshot-ai/kosong';

export interface CreateGoalInput {
  readonly objective: string;
  readonly replace?: boolean;
}

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export interface KimiHarnessOptions {
  readonly identity?: KimiHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly autoLoadConfig?: boolean | undefined;
  readonly uiMode?: string;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface CreateSessionOptions {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly planMode?: boolean;
  readonly metadata?: JsonObject | undefined;
  readonly kaos?: Kaos | undefined;
  readonly persistenceKaos?: Kaos | undefined;
  readonly additionalDirs?: readonly string[];
  readonly sessionStartedProperties?: TelemetryProperties;
  /**
   * Print-mode (`kimi -p`) only: when the main agent ends a turn while
   * background subagents (`kind === 'agent'`) are still running, hold the turn
   * open and idle-wait until they all finish, flushing their completions into
   * the turn so the model can react before the run exits. Ignored by
   * interactive / SDK sessions.
   */
  readonly drainAgentTasksOnStop?: boolean;
}

export interface RenameSessionInput {
  readonly id: string;
  readonly title: string;
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly kaos?: Kaos | undefined;
  readonly persistenceKaos?: Kaos | undefined;
  readonly additionalDirs?: readonly string[];
  /** Include persisted subagent states in the returned replay snapshot. */
  readonly includeSubagents?: boolean;
  /**
   * Limit each returned agent replay to the most recent N user turns. Omit to
   * return the full replay. Lets UI callers that only render the tail avoid
   * transferring the entire history over the RPC boundary.
   */
  readonly replayTurnLimit?: number;
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface ReloadSessionInput extends ResumeSessionInput {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface AddAdditionalDirInput {
  readonly id: string;
  readonly path: string;
  readonly persist: boolean;
}

export interface AddAdditionalDirOptions {
  /** When true, share the directory through workspace local config. When false,
   * keep it scoped to this session while still restoring it on session resume. */
  readonly persist: boolean;
}

export interface ForkSessionInput {
  readonly id: string;
  readonly forkId?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
  /**
   * Zero-based index of the user-visible turn to retain through. Omit it to
   * preserve the existing full-session fork behavior.
   */
  readonly turnIndex?: number;
}

export interface ExportSessionInput {
  readonly id: string;
  readonly outputPath?: string | undefined;
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ListSessionsOptions {
  readonly workDir?: string;
  readonly sessionId?: string;
}

export interface GetConfigOptions {
  readonly reload?: boolean | undefined;
}

export interface AuthenticateMcpServerOptions {
  readonly onAuthorizationUrl: (
    url: string,
  ) => void | boolean | PromiseLike<void | boolean>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TestMcpServerOptions {
  readonly cwd?: string;
}

export interface CompactOptions {
  readonly instruction?: string | undefined;
}

export interface ReloadSessionOptions {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface PlanInfo {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export type SessionPlan = PlanInfo | null;

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsage {
  readonly byModel?: Record<string, TokenUsage> | undefined;
  readonly currentTurn?: TokenUsage | undefined;
  readonly total?: TokenUsage | undefined;
}

export interface SessionStatus {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode?: boolean | undefined;
  readonly expertTeam?: ExpertTeamSnapshot | null;
  readonly expertTeamStatus?: ExpertTeamStatusSnapshot | null;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: SessionUsage;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

export type ResumedSessionState = Pick<ResumeSessionResult, 'sessionMetadata' | 'agents' | 'warning'>;

export interface ResumedSessionSummary extends SessionSummary, ResumedSessionState { }
