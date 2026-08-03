/**
 * `rpc` domain (L7) — Agent RPC contract and shared wire DTOs.
 *
 * Defines the implemented Agent-scoped facade contract and request/response
 * types shared by edge adapters. `PromptPayload.disabledTools` is the
 * client-managed session denylist, applied via
 * `IAgentProfileService.setSessionDisabledTools` before the prompt is
 * enqueued: full-replace semantics, the profile's own `disallowedTools`
 * always survive, omitting the field keeps the persisted value, and `[]`
 * clears the client portion. It is ignored by engines without profile
 * support.
 */

import type { AgentContextData, UserPromptOrigin } from '#/agent/contextMemory/types';
import type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '#/agent/goal/types';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { SwarmModeTrigger } from '#/agent/swarm/swarm';
import type { ToolDisclosure, ToolInfo } from '#/tool/toolContract';
import type { ResolvedConfig } from '#/app/config/config';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { ContentPart } from '#/kosong/contract/message';

import type { PluginInfo, PluginSummary, ReloadSummary } from '#/app/plugin/types';

export type { ExportSessionManifest, ExportSessionPayload, ExportSessionResult, ShellEnvironment } from '#/app/sessionExport/sessionExport';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export type EmptyPayload = {};
export type SessionMetadataPatch = Partial<Omit<SessionMeta, 'agents'>>;

export interface ClientTelemetryInfo {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly uiMode?: string | undefined;
}

export interface CreateSessionPayload {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly additionalDirs?: readonly string[];
  readonly client?: ClientTelemetryInfo | undefined;
}

export interface CloseSessionPayload {
  readonly sessionId: string;
}

export interface ArchiveSessionPayload {
  readonly sessionId: string;
}

export interface ResumeSessionPayload {
  readonly sessionId: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly additionalDirs?: readonly string[];
}

export interface ReloadSessionPayload {
  readonly sessionId: string;
  readonly forcePluginSessionStartReminder?: boolean | undefined;
}

export interface ForkSessionPayload {
  readonly sessionId: string;
  readonly id?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export interface ListSessionsPayload {
  readonly workDir?: string;
  readonly sessionId?: string;
  readonly includeArchive?: boolean;
}

export interface CoreInfo {
  readonly version: string;
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

export interface PromptPayload {
  readonly input: readonly ContentPart[];
  readonly disabledTools?: readonly string[];
  readonly origin?: UserPromptOrigin;
}
export interface RunShellCommandPayload {
  readonly command: string;
  readonly commandId?: string;
}
export interface ShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}
export interface CancelShellCommandPayload {
  readonly commandId: string;
}
export interface SteerPayload {
  readonly input: readonly ContentPart[];
}
export interface CancelPayload {
  readonly turnId?: number;
}
export interface SetThinkingPayload {
  readonly level: string;
}
export interface SetPermissionPayload {
  readonly mode: PermissionMode;
}
export interface SetModelPayload {
  readonly model: string;
}
export interface SetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}
export interface CancelPlanPayload {
  readonly id?: string;
}
export interface EnterSwarmPayload {
  readonly trigger: SwarmModeTrigger;
}
export interface BeginCompactionPayload {
  readonly instruction?: string;
}
export interface UndoHistoryPayload {
  readonly count: number;
}
export interface RegisterToolPayload {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: ToolDisclosure;
}
export interface UnregisterToolPayload {
  readonly name: string;
}
export interface SetActiveToolsPayload {
  readonly names: readonly string[];
}
export interface StopTaskPayload {
  readonly taskId: string;
  readonly reason?: string;
}
export interface DetachTaskPayload {
  readonly taskId: string;
}
export interface GetTaskOutputPayload {
  readonly taskId: string;
  readonly tail?: number;
}
export interface GetTasksPayload {
  readonly activeOnly?: boolean;
  readonly limit?: number;
}
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'builtin' | 'user' | 'extra' | 'project';
  readonly type?: string | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  readonly isSubSkill?: boolean | undefined;
}

export interface ActivateSkillPayload {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ActivatePluginCommandPayload {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

export interface ReconnectMcpServerPayload {
  readonly name: string;
}

export interface InstallPluginPayload {
  readonly source: string;
}

export interface SetPluginEnabledPayload {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SetPluginMcpServerEnabledPayload {
  readonly id: string;
  readonly server: string;
  readonly enabled: boolean;
}

export interface RemovePluginPayload {
  readonly id: string;
}

export interface GetPluginInfoPayload {
  readonly id: string;
}

export type ReloadPluginsResult = ReloadSummary;
export type { PluginSummary, PluginInfo };

export interface AddAdditionalDirPayload {
  readonly path: string;
  readonly persist: boolean;
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

export interface RenameSessionPayload {
  readonly title: string;
}

export interface UpdateSessionMetadataPayload {
  readonly metadata: SessionMetadataPatch;
}

export type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
};

export interface CreateGoalPayload {
  readonly objective: string;
  readonly replace?: boolean;
}

export interface GetKimiConfigPayload {
  readonly reload?: boolean;
}

export interface ConfigDiagnostics {
  readonly warnings: readonly string[];
}

export type SetKimiConfigPayload = ResolvedConfig;

export interface RemoveKimiProviderPayload {
  readonly providerId: string;
}

export interface PromptLaunchResult {
  readonly turn_id: number;
}

export interface AgentAPI {
  prompt: (payload: PromptPayload) => PromptLaunchResult | undefined;
  steer: (payload: SteerPayload) => PromptLaunchResult | undefined;
  cancel: (payload: CancelPayload) => void;
  undoHistory: (payload: UndoHistoryPayload) => Promise<number>;
  setPermission: (payload: SetPermissionPayload) => void;
  cancelCompaction: (payload: EmptyPayload) => void;
  activateSkill: (payload: ActivateSkillPayload) => void;
  activatePluginCommand: (payload: ActivatePluginCommandPayload) => void;
  getContext: (payload: EmptyPayload) => AgentContextData;
  getTools: (payload: EmptyPayload) => readonly ToolInfo[];
}
