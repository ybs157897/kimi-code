/**
 * Compile-time parity checks between klient wire schemas and the engine
 * types they mirror. Plain `.ts` (not `.test.ts`) — vitest must not pick it
 * up; `tsc -p tsconfig.json --noEmit` is the check.
 *
 * Wire shapes the engine imports from `@moonshot-ai/protocol` are reached
 * through indexed access on the engine service interfaces, since klient does
 * not depend on the protocol package directly.
 */

import type { z } from 'zod';

import type {
  ActivityLastTurnState,
  ActivityRetryState,
  ActivityTurnState,
  ActivityViewLifecycle,
  AgentActivityState,
  ApprovalRef,
  BackgroundRef,
  ToolCallRef,
  TurnPhase,
} from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type { AgentContextData } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import type {
  ActivateExtensionCommandInput,
  IAgentExtensionService,
} from '@moonshot-ai/agent-core-v2/agent/extension/agentExtension';
import type {
  FullCompactionInput,
  IAgentFullCompactionService,
} from '@moonshot-ai/agent-core-v2/agent/fullCompaction/fullCompaction';
import type {
  GoalReasonInput,
  IAgentGoalService,
  ResumeGoalInput,
} from '@moonshot-ai/agent-core-v2/agent/goal/goal';
import type {
  CreateGoalInput,
  GoalBudgetReport,
  GoalSnapshot,
  GoalToolResult,
} from '@moonshot-ai/agent-core-v2/agent/goal/types';
import type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { McpServerEntry } from '@moonshot-ai/agent-core-v2/agent/mcp/connection-manager';
import type { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import type { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import type {
  IAgentSwarmService,
  SwarmModeTrigger,
} from '@moonshot-ai/agent-core-v2/agent/swarm/swarm';
import type { PlanData } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import type { IAgentReplayView } from '@moonshot-ai/agent-core-v2/agent/replayView/agentReplayView';
import type { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import type {
  BindAgentInput,
  IAgentProfileService,
  ProfileData,
} from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type {
  ActivatePluginCommandPayload,
  ActivateSkillPayload,
  AgentAPI,
  CancelPlanPayload,
  CancelShellCommandPayload,
  EmptyPayload,
  GetTaskOutputPayload,
  GetTasksPayload,
  PromptPart,
  RunShellCommandPayload,
  SetModelPayload,
  SetModelResult,
  ShellCommandResult,
  StopTaskPayload,
  UndoHistoryPayload,
} from '@moonshot-ai/agent-core-v2/agent/rpc/core-api';
import type { UsageStatus } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { CronTask } from '@moonshot-ai/agent-core-v2/app/cron/cronTask';
import type { ISessionCronService } from '@moonshot-ai/agent-core-v2/session/cron/sessionCronService';
import type { ISessionScopeHandle } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import type {
  CreateChildSessionOptions,
  CreateSessionOptions,
  ForkSessionOptions,
} from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  Interaction,
  InteractionResolution,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import type {
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  ExpertTeamDefinition,
  ExpertTeamSnapshot,
} from '@moonshot-ai/agent-core-v2/session/expertTeam/expertTeam';
import type {
  GoalQueueMoveDirection,
  GoalQueueSnapshot,
  ISessionGoalQueueService,
  UpcomingGoal,
} from '@moonshot-ai/agent-core-v2/session/goalQueue/sessionGoalQueue';
import type {
  ExtensionCommandDefinition,
  ExtensionLoadError,
} from '@moonshot-ai/agent-core-v2/app/extension/extension.types';
import type {
  ExtensionReloadSummary,
  ISessionExtensionService,
} from '@moonshot-ai/agent-core-v2/session/extension/sessionExtension';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetadataChangedEvent,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type {
  AuthStatus,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import type { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import type {
  ConfigDiagnostic,
  ConfigInspectValue,
  ConfigTarget,
} from '@moonshot-ai/agent-core-v2/app/config/config';
import type { ExperimentalFeatureState } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import type { ModelRecord } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { ModelCapability } from '@moonshot-ai/agent-core-v2/kosong/contract/capability';
import type { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import type { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';
import type {
  GetPluginInfoInput,
  InstallPluginInput,
  RemovePluginInput,
  SetPluginEnabledInput,
  SetPluginMcpServerEnabledInput,
} from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import type {
  PluginCommandDef,
  PluginDiagnostic,
  PluginGithubMetadata,
  PluginInfo,
  PluginManifest,
  PluginMcpServerInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from '@moonshot-ai/agent-core-v2/app/plugin/types';
import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import type {
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import type {
  ExportSessionManifest,
  ExportSessionPayload,
  ExportSessionResult,
  ISessionExportService,
  ShellEnvironment,
} from '@moonshot-ai/agent-core-v2/app/sessionExport/sessionExport';
import type {
  Workspace,
  WorkspaceUpdate,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import type {
  AddAdditionalDirInput,
  ISessionWorkspaceCommandService,
  WorkspaceAdditionalDirsResult,
} from '@moonshot-ai/agent-core-v2/session/workspaceCommand/workspaceCommand';
import type { ISessionWorkspaceContext } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceContext';
import type {
  ISessionSecondaryModelWarningService,
  SecondaryModelWarning,
} from '@moonshot-ai/agent-core-v2/session/subagent/secondaryModelWarning';
import type { ISessionInitService } from '@moonshot-ai/agent-core-v2/session/sessionInit/sessionInit';
import type { ISessionBtwService } from '@moonshot-ai/agent-core-v2/session/btw/btw';
import type { ISessionSkillCatalog } from '@moonshot-ai/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
// Test-only: `@moonshot-ai/protocol` is a devDependency; importing its types
// here (never in `src/`) strengthens parity for the agent event stream.
import type {
  AssistantDeltaEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CronFiredEvent,
  GoalUpdatedEvent,
  HookResultEvent,
  McpServerStatusEvent,
  NoticeEvent,
  PluginCommandActivatedEvent,
  PromptAbortedEvent,
  PromptCompletedEvent,
  ShellOutputEvent,
  ShellStartedEvent,
  SkillActivatedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  TaskStartedEvent,
  TaskTerminatedEvent,
  TaskInfo,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolListUpdatedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
  TurnStartedEvent,
  WarningEvent,
} from '@moonshot-ai/protocol';

import {
  activityLastTurnStateSchema,
  activityRetryStateSchema,
  activityTurnStateSchema,
  activityViewLifecycleSchema,
  agentActivityStateSchema,
  approvalRefSchema,
  backgroundRefSchema,
  toolCallRefSchema,
  turnEndReasonSchema,
  turnPhaseSchema,
} from '../src/contract/agent/activity.js';
import {
  agentGoalContract,
  createGoalInputSchema,
  goalBudgetReportSchema,
  goalReasonInputSchema,
  goalSnapshotSchema,
  goalToolResultSchema,
  resumeGoalInputSchema,
} from '../src/contract/agent/goal.js';
import {
  activatePluginCommandPayloadSchema,
  activateSkillPayloadSchema,
  agentRpcContract,
  agentContextDataSchema,
  agentTaskInfoSchema,
  cancelPayloadSchema,
  cancelPlanPayloadSchema,
  cancelShellCommandPayloadSchema,
  emptyPayloadSchema,
  getTaskOutputPayloadSchema,
  getTasksPayloadSchema,
  planDataSchema,
  promptLaunchResultSchema,
  promptPartSchema,
  promptPayloadSchema,
  runShellCommandPayloadSchema,
  setModelPayloadSchema,
  setModelResultSchema,
  setPermissionPayloadSchema,
  shellCommandResultSchema,
  steerPayloadSchema,
  stopTaskPayloadSchema,
  tokenUsageSchema,
  undoHistoryPayloadSchema,
  usageStatusSchema,
} from '../src/contract/agent/rpc.js';
import {
  agentFullCompactionContract,
  agentMcpContract,
  agentReplayViewContract,
  agentTaskContract,
  bindAgentInputSchema,
  fullCompactionInputSchema,
  mcpServerEntrySchema,
  modelCapabilitySchema,
  profileDataSchema,
  resumedAgentStateSchema,
  thinkingLevelSchema,
} from '../src/contract/agent/services.js';
import {
  agentSwarmContract,
  swarmModeTriggerSchema,
} from '../src/contract/agent/swarm.js';
import {
  assistantDeltaEventSchema,
  compactionBlockedEventSchema,
  compactionCancelledEventSchema,
  compactionCompletedEventSchema,
  compactionStartedEventSchema,
  cronFiredEventSchema,
  goalUpdatedEventSchema,
  hookResultEventSchema,
  mcpServerStatusEventSchema,
  noticeEventSchema,
  pluginCommandActivatedEventSchema,
  promptAbortedEventSchema,
  promptCompletedEventSchema,
  shellOutputEventSchema,
  shellStartedEventSchema,
  skillActivatedEventSchema,
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  taskStartedEventSchema,
  taskTerminatedEventSchema,
  thinkingDeltaEventSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolListUpdatedEventSchema,
  toolProgressEventSchema,
  toolResultEventSchema,
  turnEndedEventSchema,
  turnStepCompletedEventSchema,
  turnStepInterruptedEventSchema,
  turnStepRetryingEventSchema,
  turnStepStartedEventSchema,
  turnStartedEventSchema,
  warningEventSchema,
} from '../src/contract/agent/events.js';
import {
  approvalRequestSchema,
  approvalResponseSchema,
} from '../src/contract/session/approval.js';
import { sessionBtwContract } from '../src/contract/session/btw.js';
import {
  cronTaskSchema,
  sessionCronContract,
} from '../src/contract/session/cron.js';
import {
  createChildSessionOptionsSchema,
  createSessionOptionsSchema,
  forkSessionOptionsSchema,
  handleWireSchema,
} from '../src/contract/session/lifecycle.js';
import {
  interactionResolutionSchema,
  interactionSchema,
} from '../src/contract/session/interaction.js';
import { sessionInitContract } from '../src/contract/session/init.js';
import {
  expertTeamDefinitionSchema,
  expertTeamSnapshotSchema,
} from '../src/contract/session/expertTeam.js';
import {
  goalQueueMoveDirectionSchema,
  goalQueueSnapshotSchema,
  sessionGoalQueueContract,
  upcomingGoalSchema,
} from '../src/contract/session/goal-queue.js';
import {
  extensionCommandDefinitionSchema,
  extensionLoadErrorSchema,
  extensionReloadSummarySchema,
  sessionExtensionContract,
} from '../src/contract/session/extension.js';
import {
  activateExtensionCommandInputSchema,
  agentExtensionContract,
} from '../src/contract/agent/extension.js';
import {
  agentMetaSchema,
  sessionMetaPatchSchema,
  sessionMetaSchema,
  sessionMetadataChangedEventSchema,
} from '../src/contract/session/metadata.js';
import {
  questionAnswersSchema,
  questionItemSchema,
  questionOptionSchema,
  questionRequestSchema,
  questionResponseSchema,
  questionResultSchema,
} from '../src/contract/session/question.js';
import {
  sessionSkillCatalogContract,
  skillSummarySchema,
} from '../src/contract/session/skill.js';
import {
  sessionSecondaryModelWarningContract,
  sessionWarningSchema,
} from '../src/contract/session/warnings.js';
import {
  addAdditionalDirInputSchema,
  sessionWorkspaceCommandContract,
  sessionWorkspaceContextContract,
  workspaceAdditionalDirsResultSchema,
} from '../src/contract/session/workspace.js';
import { agentPermissionModeContract } from '../src/contract/agent/permission.js';

import {
  authContract,
  authManagedUsageResultSchema,
  authStatusSchema,
  completeFeedbackUploadBodySchema,
  completeFeedbackUploadResultSchema,
  createFeedbackUploadUrlBodySchema,
  createFeedbackUploadUrlResultSchema,
  oAuthFlowSnapshotSchema,
  oAuthFlowStartSchema,
  oAuthLoginCancelResponseSchema,
  oAuthLogoutResponseSchema,
  refreshOAuthProviderModelsResponseSchema,
  submitFeedbackBodySchema,
  submitFeedbackResultSchema,
} from '../src/contract/global/auth.js';
import {
  configDiagnosticSchema,
  configInspectValueSchema,
  configTargetSchema,
} from '../src/contract/global/config.js';
import {
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  setDefaultModelResponseSchema,
} from '../src/contract/global/catalog.js';
import {
  refreshProviderModelsOptionsSchema,
  refreshProviderModelsResponseSchema,
} from '../src/contract/global/providerDiscovery.js';
import { experimentalFeatureStateSchema } from '../src/contract/global/flags.js';
import {
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '../src/contract/global/hostFs.js';
import { modelConfigSchema } from '../src/contract/global/models.js';
import {
  getPluginInfoInputSchema,
  installPluginInputSchema,
  pluginCommandDefSchema,
  pluginDiagnosticSchema,
  pluginGithubMetadataSchema,
  pluginInfoSchema,
  pluginManifestSchema,
  pluginMcpServerInfoSchema,
  pluginSummarySchema,
  pluginUpdateStatusSchema,
  reloadSummarySchema,
  removePluginInputSchema,
  setPluginEnabledInputSchema,
  setPluginMcpServerEnabledInputSchema,
} from '../src/contract/global/plugins.js';
import { providerConfigSchema } from '../src/contract/global/providers.js';
import {
  sessionListQuerySchema,
  sessionSummarySchema,
} from '../src/contract/global/sessions.js';
import {
  exportSessionManifestSchema,
  exportSessionPayloadSchema,
  exportSessionResultSchema,
  sessionExportContract,
  shellEnvironmentSchema,
} from '../src/contract/global/session-export.js';
import {
  workspaceSchema,
  workspaceUpdateSchema,
} from '../src/contract/global/workspaces.js';

import type { AssertWire, MutableDeep } from './helpers/typeAssert.js';

/** One-directional: the engine type must be assignable TO the schema's infer. */
type AssertEngineToWire<TSchema extends z.ZodType, TEngine> = [MutableDeep<TEngine>] extends [
  z.infer<TSchema>,
]
  ? true
  : never;

/** One-directional: the schema's infer must be assignable TO the engine type. */
type AssertWireToEngine<TSchema extends z.ZodType, TEngine> = [z.infer<TSchema>] extends [
  MutableDeep<TEngine>,
]
  ? true
  : never;

type AssertTypeEqual<TLeft, TRight> = ([TLeft] extends [TRight] ? true : never) &
  ([TRight] extends [TLeft] ? true : never);

// Protocol wire shapes, derived from the engine interfaces (no direct
// `@moonshot-ai/protocol` dependency in klient).
type OAuthFlowStart = Awaited<ReturnType<IOAuthService['startLogin']>>;
type OAuthFlowSnapshot = NonNullable<ReturnType<IOAuthService['getFlow']>>;
type OAuthLoginCancelResponse = Awaited<ReturnType<IOAuthService['cancelLogin']>>;
type OAuthLogoutResponse = Awaited<ReturnType<IOAuthService['logout']>>;
type AuthManagedUsageResult = Awaited<ReturnType<IOAuthService['getManagedUsage']>>;
type SubmitFeedbackBody = Parameters<IOAuthService['submitFeedback']>[0];
type SubmitFeedbackResult = Awaited<ReturnType<IOAuthService['submitFeedback']>>;
type CreateFeedbackUploadUrlBody = Parameters<IOAuthService['createFeedbackUploadUrl']>[0];
type CreateFeedbackUploadUrlResult = Awaited<
  ReturnType<IOAuthService['createFeedbackUploadUrl']>
>;
type CompleteFeedbackUploadBody = Parameters<IOAuthService['completeFeedbackUpload']>[0];
type CompleteFeedbackUploadResult = Awaited<
  ReturnType<IOAuthService['completeFeedbackUpload']>
>;
type RefreshOAuthProviderModelsResponse = Awaited<
  ReturnType<IOAuthService['refreshOAuthProviderModels']>
>;
/** String-enum value union (`'user' | 'memory'`). */
type ConfigTargetValues = `${ConfigTarget}`;

// sessions.ts
const _sessionSummary: AssertWire<typeof sessionSummarySchema, SessionSummary> = true;
const _sessionListQuery: AssertWire<typeof sessionListQuerySchema, SessionListQuery> = true;

// session-export.ts — the App-scope wire method exposes only the serializable
// request payload, not the service's process-local options.
const _shellEnvironment: AssertWire<typeof shellEnvironmentSchema, ShellEnvironment> = true;
const _exportSessionPayload: AssertWire<
  typeof exportSessionPayloadSchema,
  ExportSessionPayload
> = true;
const _exportSessionManifest: AssertWire<
  typeof exportSessionManifestSchema,
  ExportSessionManifest
> = true;
const _exportSessionResult: AssertWire<
  typeof exportSessionResultSchema,
  ExportSessionResult
> = true;
const _sessionExportInput: AssertTypeEqual<
  z.infer<typeof sessionExportContract.export.input>,
  [Parameters<ISessionExportService['export']>[0]]
> = true;
const _sessionExportOutput: AssertWire<
  typeof sessionExportContract.export.output,
  Awaited<ReturnType<ISessionExportService['export']>>
> = true;

// workspaces.ts
const _workspace: AssertWire<typeof workspaceSchema, Workspace> = true;
const _workspaceUpdate: AssertWire<typeof workspaceUpdateSchema, WorkspaceUpdate> = true;

// config.ts
// One-directional: the engine declares the `ConfigInspectValue` keys as
// required with `| undefined` values, while the wire schema marks them
// `.optional()`; optional → required is not assignable, so only the
// engine → wire direction holds.
const _configInspectValue: AssertEngineToWire<typeof configInspectValueSchema, ConfigInspectValue> =
  true;
const _configDiagnostic: AssertWire<typeof configDiagnosticSchema, ConfigDiagnostic> = true;
const _configTarget: AssertWire<typeof configTargetSchema, ConfigTargetValues> = true;

// providers.ts
const _providerConfig: AssertWire<typeof providerConfigSchema, ProviderConfig> = true;

// auth.ts
const _oAuthFlowStart: AssertWire<typeof oAuthFlowStartSchema, OAuthFlowStart> = true;
const _oAuthFlowSnapshot: AssertWire<typeof oAuthFlowSnapshotSchema, OAuthFlowSnapshot> = true;
const _oAuthLoginCancelResponse: AssertWire<
  typeof oAuthLoginCancelResponseSchema,
  OAuthLoginCancelResponse
> = true;
const _oAuthLogoutResponse: AssertWire<typeof oAuthLogoutResponseSchema, OAuthLogoutResponse> =
  true;
const _authStatus: AssertWire<typeof authStatusSchema, AuthStatus> = true;
const _authManagedUsageResult: AssertWire<
  typeof authManagedUsageResultSchema,
  AuthManagedUsageResult
> = true;
const _getManagedUsageInput: AssertTypeEqual<
  z.infer<typeof authContract.getManagedUsage.input>,
  Parameters<IOAuthService['getManagedUsage']>
> = true;
const _submitFeedbackBody: AssertWire<
  typeof submitFeedbackBodySchema,
  SubmitFeedbackBody
> = true;
const _submitFeedbackResult: AssertWire<
  typeof submitFeedbackResultSchema,
  SubmitFeedbackResult
> = true;
const _submitFeedbackInput: AssertTypeEqual<
  z.infer<typeof authContract.submitFeedback.input>,
  Parameters<IOAuthService['submitFeedback']>
> = true;
const _createFeedbackUploadUrlBody: AssertWire<
  typeof createFeedbackUploadUrlBodySchema,
  CreateFeedbackUploadUrlBody
> = true;
const _createFeedbackUploadUrlResult: AssertWire<
  typeof createFeedbackUploadUrlResultSchema,
  CreateFeedbackUploadUrlResult
> = true;
const _createFeedbackUploadUrlInput: AssertTypeEqual<
  z.infer<typeof authContract.createFeedbackUploadUrl.input>,
  Parameters<IOAuthService['createFeedbackUploadUrl']>
> = true;
const _completeFeedbackUploadBody: AssertWire<
  typeof completeFeedbackUploadBodySchema,
  CompleteFeedbackUploadBody
> = true;
const _completeFeedbackUploadResult: AssertWire<
  typeof completeFeedbackUploadResultSchema,
  CompleteFeedbackUploadResult
> = true;
const _completeFeedbackUploadInput: AssertTypeEqual<
  z.infer<typeof authContract.completeFeedbackUpload.input>,
  [MutableDeep<CompleteFeedbackUploadBody>, provider?: string]
> = true;
const _refreshOAuthProviderModelsResponse: AssertWire<
  typeof refreshOAuthProviderModelsResponseSchema,
  RefreshOAuthProviderModelsResponse
> = true;

// flags.ts
const _experimentalFeatureState: AssertWire<
  typeof experimentalFeatureStateSchema,
  ExperimentalFeatureState
> = true;

// hostFs.ts
const _fsBrowseResponse: AssertWire<typeof fsBrowseResponseSchema, FsBrowseResponse> = true;
const _fsHomeResponse: AssertWire<typeof fsHomeResponseSchema, FsHomeResponse> = true;

// catalog.ts / providerDiscovery.ts — protocol wire shapes derived through the
// catalog and discovery service interfaces.
type ModelCatalogItem = Awaited<ReturnType<IModelCatalog['listModels']>>[number];
type ProviderCatalogItem = Awaited<ReturnType<IModelCatalog['listProviders']>>[number];
type SetDefaultModelResponse = Awaited<ReturnType<IModelCatalog['setDefaultModel']>>;
type RefreshProviderModelsOptions = NonNullable<
  Parameters<IProviderDiscoveryService['refreshProviderModels']>[0]
>;
type RefreshProviderModelsResponse = Awaited<
  ReturnType<IProviderDiscoveryService['refreshProviderModels']>
>;
const _modelCatalogItem: AssertWire<typeof modelCatalogItemSchema, ModelCatalogItem> = true;
const _providerCatalogItem: AssertWire<typeof providerCatalogItemSchema, ProviderCatalogItem> =
  true;
const _setDefaultModelResponse: AssertWire<
  typeof setDefaultModelResponseSchema,
  SetDefaultModelResponse
> = true;
const _refreshProviderModelsOptions: AssertWire<
  typeof refreshProviderModelsOptionsSchema,
  RefreshProviderModelsOptions
> = true;
const _refreshProviderModelsResponse: AssertWire<
  typeof refreshProviderModelsResponseSchema,
  RefreshProviderModelsResponse
> = true;

// models.ts
const _modelConfig: AssertWire<typeof modelConfigSchema, ModelRecord> = true;

// plugins.ts
const _pluginSummary: AssertWire<typeof pluginSummarySchema, PluginSummary> = true;
const _pluginInfo: AssertWire<typeof pluginInfoSchema, PluginInfo> = true;
const _pluginManifest: AssertWire<typeof pluginManifestSchema, PluginManifest> = true;
const _pluginMcpServerInfo: AssertWire<typeof pluginMcpServerInfoSchema, PluginMcpServerInfo> =
  true;
const _pluginDiagnostic: AssertWire<typeof pluginDiagnosticSchema, PluginDiagnostic> = true;
const _pluginGithubMetadata: AssertWire<typeof pluginGithubMetadataSchema, PluginGithubMetadata> =
  true;
const _reloadSummary: AssertWire<typeof reloadSummarySchema, ReloadSummary> = true;
const _pluginUpdateStatus: AssertWire<typeof pluginUpdateStatusSchema, PluginUpdateStatus> = true;
const _pluginCommandDef: AssertWire<typeof pluginCommandDefSchema, PluginCommandDef> = true;
const _installPluginInput: AssertWire<typeof installPluginInputSchema, InstallPluginInput> = true;
const _setPluginEnabledInput: AssertWire<
  typeof setPluginEnabledInputSchema,
  SetPluginEnabledInput
> = true;
const _setPluginMcpServerEnabledInput: AssertWire<
  typeof setPluginMcpServerEnabledInputSchema,
  SetPluginMcpServerEnabledInput
> = true;
const _removePluginInput: AssertWire<typeof removePluginInputSchema, RemovePluginInput> = true;
const _getPluginInfoInput: AssertWire<typeof getPluginInfoInputSchema, GetPluginInfoInput> = true;

// env.ts has no named schemas; `platform` narrows to `NodeJS.Platform` in the
// engine — assert the bootstrap properties are all strings instead.
type _bootstrapStringProps = AssertStringProps<
  Pick<
    IBootstrapService,
    | 'platform'
    | 'arch'
    | 'cwd'
    | 'osHomeDir'
    | 'homeDir'
    | 'configPath'
    | 'clientVersion'
    | 'sessionsDir'
    | 'blobsDir'
    | 'storeDir'
    | 'cacheDir'
    | 'logsDir'
  >
>;
type AssertStringProps<T> = T extends Record<string, string> ? true : never;
const _envProps: _bootstrapStringProps = true;

// ── session scope ───────────────────────────────────────────────────────────

// session/metadata.ts
const _sessionMeta: AssertWire<typeof sessionMetaSchema, SessionMeta> = true;
const _agentMeta: AssertWire<typeof agentMetaSchema, AgentMeta> = true;
const _sessionMetaPatch: AssertWire<typeof sessionMetaPatchSchema, SessionMetaPatch> = true;
const _sessionMetadataChangedEvent: AssertWire<
  typeof sessionMetadataChangedEventSchema,
  SessionMetadataChangedEvent
> = true;

// session/lifecycle.ts
const _createSessionOptions: AssertWire<typeof createSessionOptionsSchema, CreateSessionOptions> =
  true;
const _forkSessionOptions: AssertWire<typeof forkSessionOptionsSchema, ForkSessionOptions> = true;
const _createChildSessionOptions: AssertWire<
  typeof createChildSessionOptionsSchema,
  CreateChildSessionOptions
> = true;
// One-directional: the wire handle is `z.looseObject` — the in-process
// `ISessionScopeHandle` carries an `accessor` and `dispose()` that JSON
// drops, so only the engine → wire direction holds.
const _handleWire: AssertEngineToWire<typeof handleWireSchema, ISessionScopeHandle> = true;

// session/interaction.ts
const _interaction: AssertWire<typeof interactionSchema, Interaction> = true;
const _interactionResolution: AssertWire<
  typeof interactionResolutionSchema,
  InteractionResolution
> = true;

// session/approval.ts
// One-directional: `display` is the protocol `ToolInputDisplay` union (huge)
// and crosses the wire as `unknown`; the wire schema cannot be assignable
// back to the engine type.
const _approvalRequest: AssertEngineToWire<typeof approvalRequestSchema, ApprovalRequest> = true;
const _approvalResponse: AssertWire<typeof approvalResponseSchema, ApprovalResponse> = true;

// session/question.ts
const _questionRequest: AssertWire<typeof questionRequestSchema, QuestionRequest> = true;
const _questionItem: AssertWire<typeof questionItemSchema, QuestionItem> = true;
const _questionOption: AssertWire<typeof questionOptionSchema, QuestionOption> = true;
const _questionAnswers: AssertWire<typeof questionAnswersSchema, QuestionAnswers> = true;
const _questionResponse: AssertWire<typeof questionResponseSchema, QuestionResponse> = true;
const _questionResult: AssertWire<typeof questionResultSchema, QuestionResult> = true;

// session/expertTeam.ts
const _expertTeamDefinition: AssertWire<
  typeof expertTeamDefinitionSchema,
  ExpertTeamDefinition
> = true;
const _expertTeamSnapshot: AssertWire<typeof expertTeamSnapshotSchema, ExpertTeamSnapshot> = true;

// session/extension.ts
const _extensionCommandDefinition: AssertWire<
  typeof extensionCommandDefinitionSchema,
  ExtensionCommandDefinition
> = true;
const _extensionLoadError: AssertWire<
  typeof extensionLoadErrorSchema,
  ExtensionLoadError
> = true;
const _extensionReloadSummary: AssertWire<
  typeof extensionReloadSummarySchema,
  ExtensionReloadSummary
> = true;
const _sessionExtensionListCommandsInput: AssertTypeEqual<
  z.infer<typeof sessionExtensionContract.listCommands.input>,
  Parameters<ISessionExtensionService['listCommands']>
> = true;
const _sessionExtensionListCommandsResult: AssertWire<
  typeof sessionExtensionContract.listCommands.output,
  Awaited<ReturnType<ISessionExtensionService['listCommands']>>
> = true;
const _sessionExtensionReloadInput: AssertTypeEqual<
  z.infer<typeof sessionExtensionContract.reload.input>,
  Parameters<ISessionExtensionService['reload']>
> = true;
const _sessionExtensionReloadResult: AssertWire<
  typeof sessionExtensionContract.reload.output,
  Awaited<ReturnType<ISessionExtensionService['reload']>>
> = true;

// agent/extension.ts
const _activateExtensionCommandInput: AssertWire<
  typeof activateExtensionCommandInputSchema,
  ActivateExtensionCommandInput
> = true;
// Extension activation/shutdown remain runtime-owned; only user command
// activation crosses the client boundary.
const _agentExtensionActivateCommandInput: AssertTypeEqual<
  z.infer<typeof agentExtensionContract.activateCommand.input>,
  Parameters<IAgentExtensionService['activateCommand']>
> = true;
const _agentExtensionActivateCommandResult: AssertWire<
  typeof agentExtensionContract.activateCommand.output,
  Awaited<ReturnType<IAgentExtensionService['activateCommand']>>
> = true;

// session/cron.ts
const _cronTask: AssertWire<typeof cronTaskSchema, CronTask> = true;
// Callback-bearing scheduling mutations stay inside the engine; the client
// exposes only the serializable read model.
const _sessionCronListInput: AssertTypeEqual<
  z.infer<typeof sessionCronContract.list.input>,
  Parameters<ISessionCronService['list']>
> = true;
const _sessionCronListResult: AssertWire<
  typeof sessionCronContract.list.output,
  ReturnType<ISessionCronService['list']>
> = true;
const _sessionCronNextFireInput: AssertTypeEqual<
  z.infer<typeof sessionCronContract.getNextFireTime.input>,
  Parameters<ISessionCronService['getNextFireTime']>
> = true;
const _sessionCronNextFireResult: AssertWire<
  typeof sessionCronContract.getNextFireTime.output,
  ReturnType<ISessionCronService['getNextFireTime']>
> = true;

// session/goal-queue.ts
const _upcomingGoal: AssertWire<typeof upcomingGoalSchema, UpcomingGoal> = true;
const _goalQueueSnapshot: AssertWire<
  typeof goalQueueSnapshotSchema,
  GoalQueueSnapshot
> = true;
const _goalQueueMoveDirection: AssertWire<
  typeof goalQueueMoveDirectionSchema,
  GoalQueueMoveDirection
> = true;
const _goalQueueReadInput: AssertTypeEqual<
  z.infer<typeof sessionGoalQueueContract.read.input>,
  Parameters<ISessionGoalQueueService['read']>
> = true;
const _goalQueueReadResult: AssertWire<
  typeof sessionGoalQueueContract.read.output,
  Awaited<ReturnType<ISessionGoalQueueService['read']>>
> = true;
const _goalQueueAppendInput: AssertTypeEqual<
  z.infer<typeof sessionGoalQueueContract.append.input>,
  Parameters<ISessionGoalQueueService['append']>
> = true;
const _goalQueueAppendResult: AssertWire<
  typeof sessionGoalQueueContract.append.output,
  Awaited<ReturnType<ISessionGoalQueueService['append']>>
> = true;
const _goalQueueUpdateInput: AssertTypeEqual<
  z.infer<typeof sessionGoalQueueContract.update.input>,
  Parameters<ISessionGoalQueueService['update']>
> = true;
const _goalQueueUpdateResult: AssertWire<
  typeof sessionGoalQueueContract.update.output,
  Awaited<ReturnType<ISessionGoalQueueService['update']>>
> = true;
const _goalQueueRemoveInput: AssertTypeEqual<
  z.infer<typeof sessionGoalQueueContract.remove.input>,
  Parameters<ISessionGoalQueueService['remove']>
> = true;
const _goalQueueRemoveResult: AssertWire<
  typeof sessionGoalQueueContract.remove.output,
  Awaited<ReturnType<ISessionGoalQueueService['remove']>>
> = true;
const _goalQueueRestoreInput: AssertTypeEqual<
  z.infer<typeof sessionGoalQueueContract.restore.input>,
  Parameters<ISessionGoalQueueService['restore']>
> = true;
const _goalQueueRestoreResult: AssertWire<
  typeof sessionGoalQueueContract.restore.output,
  Awaited<ReturnType<ISessionGoalQueueService['restore']>>
> = true;
const _goalQueueMoveInput: AssertTypeEqual<
  z.infer<typeof sessionGoalQueueContract.move.input>,
  Parameters<ISessionGoalQueueService['move']>
> = true;
const _goalQueueMoveResult: AssertWire<
  typeof sessionGoalQueueContract.move.output,
  Awaited<ReturnType<ISessionGoalQueueService['move']>>
> = true;

// agent/goal.ts
const _createGoalInput: AssertWire<typeof createGoalInputSchema, CreateGoalInput> = true;
const _goalReasonInput: AssertWire<typeof goalReasonInputSchema, GoalReasonInput> = true;
const _resumeGoalInput: AssertWire<typeof resumeGoalInputSchema, ResumeGoalInput> = true;
const _goalBudgetReport: AssertWire<typeof goalBudgetReportSchema, GoalBudgetReport> = true;
const _goalSnapshot: AssertWire<typeof goalSnapshotSchema, GoalSnapshot> = true;
const _goalToolResult: AssertWire<typeof goalToolResultSchema, GoalToolResult> = true;
const _agentGoalGetInput: AssertTypeEqual<
  z.infer<typeof agentGoalContract.getGoal.input>,
  Parameters<IAgentGoalService['getGoal']>
> = true;
const _agentGoalGetResult: AssertWire<
  typeof agentGoalContract.getGoal.output,
  ReturnType<IAgentGoalService['getGoal']>
> = true;
// GoalActor is engine-owned provenance. Client callers intentionally receive
// only the first public input parameter and cannot impersonate model actions.
const _agentGoalCreateInput: AssertTypeEqual<
  z.infer<typeof agentGoalContract.createGoal.input>,
  [Parameters<IAgentGoalService['createGoal']>[0]]
> = true;
const _agentGoalCreateResult: AssertWire<
  typeof agentGoalContract.createGoal.output,
  Awaited<ReturnType<IAgentGoalService['createGoal']>>
> = true;
const _agentGoalPauseInput: AssertTypeEqual<
  z.infer<typeof agentGoalContract.pauseGoal.input>,
  [Parameters<IAgentGoalService['pauseGoal']>[0]?]
> = true;
const _agentGoalPauseResult: AssertWire<
  typeof agentGoalContract.pauseGoal.output,
  Awaited<ReturnType<IAgentGoalService['pauseGoal']>>
> = true;
const _agentGoalResumeInput: AssertTypeEqual<
  z.infer<typeof agentGoalContract.resumeGoal.input>,
  [Parameters<IAgentGoalService['resumeGoal']>[0]?]
> = true;
const _agentGoalResumeResult: AssertWire<
  typeof agentGoalContract.resumeGoal.output,
  Awaited<ReturnType<IAgentGoalService['resumeGoal']>>
> = true;
const _agentGoalCancelInput: AssertTypeEqual<
  z.infer<typeof agentGoalContract.cancelGoal.input>,
  [Parameters<IAgentGoalService['cancelGoal']>[0]?]
> = true;
const _agentGoalCancelResult: AssertWire<
  typeof agentGoalContract.cancelGoal.output,
  Awaited<ReturnType<IAgentGoalService['cancelGoal']>>
> = true;

// agent/profile control plane
const _bindAgentInput: AssertWire<typeof bindAgentInputSchema, BindAgentInput> = true;
const _modelCapability: AssertWire<typeof modelCapabilitySchema, ModelCapability> = true;
const _profileData: AssertWire<typeof profileDataSchema, ProfileData> = true;
const _thinkingLevel: AssertWire<
  typeof thinkingLevelSchema,
  Parameters<IAgentProfileService['setThinking']>[0]
> = true;

// agent/replayView.ts — a single Agent-scope read returns the complete
// wire-safe replay snapshot; the facade does not assemble individual slices.
const _agentReplayReadInput: AssertTypeEqual<
  z.infer<typeof agentReplayViewContract.read.input>,
  Parameters<IAgentReplayView['read']>
> = true;
const _resumedAgentState: AssertWire<
  typeof resumedAgentStateSchema,
  Awaited<ReturnType<IAgentReplayView['read']>>
> = true;

// agent/fullCompaction.ts — property access pins the exposed method name;
// payload/result parity keeps the deliberately begin-only wire surface narrow.
const _fullCompactionInput: AssertWire<typeof fullCompactionInputSchema, FullCompactionInput> = true;
const _fullCompactionBeginResult: AssertWire<
  typeof agentFullCompactionContract.begin.output,
  Awaited<ReturnType<IAgentFullCompactionService['begin']>>
> = true;

// agent/mcp.ts — only the wire-safe list/metrics/reconnect subset is exposed.
const _mcpServerEntry: AssertWire<typeof mcpServerEntrySchema, McpServerEntry> = true;
const _mcpListInput: AssertTypeEqual<
  z.infer<typeof agentMcpContract.list.input>,
  Parameters<IAgentMcpService['list']>
> = true;
const _mcpListResult: AssertWire<
  typeof agentMcpContract.list.output,
  Awaited<ReturnType<IAgentMcpService['list']>>
> = true;
const _mcpInitialLoadDurationInput: AssertTypeEqual<
  z.infer<typeof agentMcpContract.initialLoadDurationMs.input>,
  Parameters<IAgentMcpService['initialLoadDurationMs']>
> = true;
const _mcpInitialLoadDurationResult: AssertWire<
  typeof agentMcpContract.initialLoadDurationMs.output,
  ReturnType<IAgentMcpService['initialLoadDurationMs']>
> = true;
// AbortSignal remains process-local; the wire method carries only the server name.
const _mcpReconnectInput: AssertTypeEqual<
  z.infer<typeof agentMcpContract.reconnect.input>,
  [Parameters<IAgentMcpService['reconnect']>[0]]
> = true;
const _mcpReconnectResult: AssertWireToEngine<
  typeof agentMcpContract.reconnect.output,
  Awaited<ReturnType<IAgentMcpService['reconnect']>>
> = true;

// agent/permission.ts — the mutation remains on AgentRPC; this service exposes
// only the current wire-safe mode.
const _permissionModeInput: AssertTypeEqual<
  z.infer<typeof agentPermissionModeContract.mode.input>,
  []
> = true;
const _permissionModeResult: AssertWire<
  typeof agentPermissionModeContract.mode.output,
  IAgentPermissionModeService['mode']
> = true;

// agent/swarm.ts — property reads and mutations stay on the swarm domain
// instead of routing through the turn-driving Agent RPC service.
const _swarmModeTrigger: AssertWire<typeof swarmModeTriggerSchema, SwarmModeTrigger> = true;
const _swarmIsActiveInput: AssertTypeEqual<
  z.infer<typeof agentSwarmContract.isActive.input>,
  []
> = true;
const _swarmIsActiveResult: AssertWire<
  typeof agentSwarmContract.isActive.output,
  IAgentSwarmService['isActive']
> = true;
const _swarmEnterInput: AssertTypeEqual<
  z.infer<typeof agentSwarmContract.enter.input>,
  Parameters<IAgentSwarmService['enter']>
> = true;
const _swarmEnterResult: AssertWireToEngine<
  typeof agentSwarmContract.enter.output,
  ReturnType<IAgentSwarmService['enter']>
> = true;
const _swarmExitInput: AssertTypeEqual<
  z.infer<typeof agentSwarmContract.exit.input>,
  Parameters<IAgentSwarmService['exit']>
> = true;
const _swarmExitResult: AssertWireToEngine<
  typeof agentSwarmContract.exit.output,
  ReturnType<IAgentSwarmService['exit']>
> = true;

// session/init.ts — both the async generator and synchronous cancellation
// normalize to Promise<void> at the facade boundary.
const _sessionInitGenerateInput: AssertTypeEqual<
  z.infer<typeof sessionInitContract.generateAgentsMd.input>,
  Parameters<ISessionInitService['generateAgentsMd']>
> = true;
const _sessionInitGenerateResult: AssertWireToEngine<
  typeof sessionInitContract.generateAgentsMd.output,
  Awaited<ReturnType<ISessionInitService['generateAgentsMd']>>
> = true;
const _sessionInitCancelInput: AssertTypeEqual<
  z.infer<typeof sessionInitContract.cancelInit.input>,
  Parameters<ISessionInitService['cancelInit']>
> = true;
const _sessionInitCancelResult: AssertWireToEngine<
  typeof sessionInitContract.cancelInit.output,
  ReturnType<ISessionInitService['cancelInit']>
> = true;

// session/btw.ts — start only returns the child id; subsequent control uses
// the existing agent facade selected by that id.
const _sessionBtwStartInput: AssertTypeEqual<
  z.infer<typeof sessionBtwContract.start.input>,
  Parameters<ISessionBtwService['start']>
> = true;
const _sessionBtwStartResult: AssertWire<
  typeof sessionBtwContract.start.output,
  Awaited<ReturnType<ISessionBtwService['start']>>
> = true;

// session/workspace.ts — expose the read-only context plus the coordinated
// additional-directory command, not the context's process-local helpers.
const _workspaceWorkDirInput: AssertTypeEqual<
  z.infer<typeof sessionWorkspaceContextContract.workDir.input>,
  []
> = true;
const _workspaceWorkDirResult: AssertWire<
  typeof sessionWorkspaceContextContract.workDir.output,
  ISessionWorkspaceContext['workDir']
> = true;
const _workspaceAdditionalDirsInput: AssertTypeEqual<
  z.infer<typeof sessionWorkspaceContextContract.additionalDirs.input>,
  []
> = true;
const _workspaceAdditionalDirsResult: AssertWire<
  typeof sessionWorkspaceContextContract.additionalDirs.output,
  ISessionWorkspaceContext['additionalDirs']
> = true;
const _addAdditionalDirInput: AssertWire<
  typeof addAdditionalDirInputSchema,
  AddAdditionalDirInput
> = true;
const _addAdditionalDirResult: AssertWire<
  typeof workspaceAdditionalDirsResultSchema,
  WorkspaceAdditionalDirsResult
> = true;
const _workspaceCommandInput: AssertTypeEqual<
  z.infer<typeof sessionWorkspaceCommandContract.addAdditionalDir.input>,
  Parameters<ISessionWorkspaceCommandService['addAdditionalDir']>
> = true;
const _workspaceCommandResult: AssertWire<
  typeof sessionWorkspaceCommandContract.addAdditionalDir.output,
  Awaited<ReturnType<ISessionWorkspaceCommandService['addAdditionalDir']>>
> = true;

// session/warnings.ts — the facade normalizes this optional engine result to
// a list, while the transport contract mirrors the underlying service 1:1.
const _sessionWarning: AssertWire<typeof sessionWarningSchema, SecondaryModelWarning> = true;
const _sessionWarningInput: AssertTypeEqual<
  z.infer<typeof sessionSecondaryModelWarningContract.getSecondaryModelWarning.input>,
  Parameters<ISessionSecondaryModelWarningService['getSecondaryModelWarning']>
> = true;
const _sessionWarningResult: AssertWire<
  typeof sessionSecondaryModelWarningContract.getSecondaryModelWarning.output,
  ReturnType<ISessionSecondaryModelWarningService['getSecondaryModelWarning']>
> = true;

// session/skill.ts + agent/rpc.ts
const _skillSummary: AssertWire<typeof skillSummarySchema, SkillSummary> = true;
const _sessionSkillReloadInput: AssertTypeEqual<
  z.infer<typeof sessionSkillCatalogContract.reload.input>,
  Parameters<ISessionSkillCatalog['reload']>
> = true;
const _sessionSkillReloadResult: AssertWireToEngine<
  typeof sessionSkillCatalogContract.reload.output,
  Awaited<ReturnType<ISessionSkillCatalog['reload']>>
> = true;
const _activateSkillPayload: AssertWire<
  typeof activateSkillPayloadSchema,
  ActivateSkillPayload
> = true;
const _activatePluginCommandPayload: AssertWire<
  typeof activatePluginCommandPayloadSchema,
  ActivatePluginCommandPayload
> = true;

// agent/activity.ts
const _turnPhase: AssertWire<typeof turnPhaseSchema, TurnPhase> = true;
const _approvalRef: AssertWire<typeof approvalRefSchema, ApprovalRef> = true;
const _toolCallRef: AssertWire<typeof toolCallRefSchema, ToolCallRef> = true;
const _activityRetryState: AssertWire<typeof activityRetryStateSchema, ActivityRetryState> = true;
// One-directional: `origin` is the deep `PromptOrigin` union mirrored as
// `unknown`; the wire schema cannot be assignable back to the engine type.
const _activityTurnState: AssertEngineToWire<typeof activityTurnStateSchema, ActivityTurnState> =
  true;
const _turnEndReason: AssertWire<typeof turnEndReasonSchema, TurnEndReason> = true;
const _activityLastTurnState: AssertWire<
  typeof activityLastTurnStateSchema,
  ActivityLastTurnState
> = true;
const _backgroundRef: AssertWire<typeof backgroundRefSchema, BackgroundRef> = true;
const _activityViewLifecycle: AssertWire<typeof activityViewLifecycleSchema, ActivityViewLifecycle> =
  true;
const _agentActivityState: AssertEngineToWire<typeof agentActivityStateSchema, AgentActivityState> =
  true;

// ── agent scope (rpc.ts) ────────────────────────────────────────────────────
// Payload/result types for the remaining `AgentAPI` methods are reached
// through the interface so the assertions track the exact methods the
// contract mirrors; payloads of the domain services the facade calls
// directly (shellCommand / profile / usage / plan / task) are imported from
// `core-api.ts` (they no longer have `AgentAPI` entries).
type PromptPayload = Parameters<AgentAPI['prompt']>[0];
type PromptLaunchResult = NonNullable<ReturnType<AgentAPI['prompt']>>;
type SteerPayload = Parameters<AgentAPI['steer']>[0];
type CancelPayload = Parameters<AgentAPI['cancel']>[0];
type CancelCompactionPayload = Parameters<AgentAPI['cancelCompaction']>[0];
type CancelCompactionResult = Awaited<ReturnType<AgentAPI['cancelCompaction']>>;
type SetPermissionPayload = Parameters<AgentAPI['setPermission']>[0];
type UndoHistoryResult = Awaited<ReturnType<AgentAPI['undoHistory']>>;
type TokenUsage = NonNullable<UsageStatus['total']>;

const _emptyPayload: AssertWire<typeof emptyPayloadSchema, EmptyPayload> = true;
const _promptPart: AssertWire<typeof promptPartSchema, PromptPart> = true;
// One-directional (wire → engine): the engine's `PromptPayload.input` accepts
// the full `ContentPart` union (also think/audio parts); the wire mirrors the
// `PromptPart` subset clients may send, so the reverse direction fails.
const _promptPayload: AssertWireToEngine<typeof promptPayloadSchema, PromptPayload> = true;
const _steerPayload: AssertWireToEngine<typeof steerPayloadSchema, SteerPayload> = true;
const _promptLaunchResult: AssertWire<typeof promptLaunchResultSchema, PromptLaunchResult> = true;
const _cancelPayload: AssertWire<typeof cancelPayloadSchema, CancelPayload> = true;
const _undoHistoryPayload: AssertWire<typeof undoHistoryPayloadSchema, UndoHistoryPayload> = true;
const _undoHistoryResult: AssertWire<
  typeof agentRpcContract.undoHistory.output,
  UndoHistoryResult
> = true;
const _cancelCompactionPayload: AssertWire<typeof emptyPayloadSchema, CancelCompactionPayload> =
  true;
// One-directional: `noResult` normalizes wire `null | undefined` to
// `undefined`, which is assignable to the engine's `void` result.
const _cancelCompactionResult: AssertWireToEngine<
  typeof agentRpcContract.cancelCompaction.output,
  CancelCompactionResult
> = true;
const _runShellCommandPayload: AssertWire<
  typeof runShellCommandPayloadSchema,
  RunShellCommandPayload
> = true;
const _shellCommandResult: AssertWire<typeof shellCommandResultSchema, ShellCommandResult> = true;
const _cancelShellCommandPayload: AssertWire<
  typeof cancelShellCommandPayloadSchema,
  CancelShellCommandPayload
> = true;
const _setModelPayload: AssertWire<typeof setModelPayloadSchema, SetModelPayload> = true;
const _setModelResult: AssertWire<typeof setModelResultSchema, SetModelResult> = true;
const _setPermissionPayload: AssertWire<typeof setPermissionPayloadSchema, SetPermissionPayload> =
  true;
const _tokenUsage: AssertWire<typeof tokenUsageSchema, TokenUsage> = true;
const _usageStatus: AssertWire<typeof usageStatusSchema, UsageStatus> = true;
// One-directional: `history` entries are full `ContextMessage`s (deep
// `Message`/`Tool`/`PromptOrigin` unions) mirrored as `unknown`.
const _agentContextData: AssertEngineToWire<typeof agentContextDataSchema, AgentContextData> = true;
const _planData: AssertWire<typeof planDataSchema, PlanData> = true;
const _cancelPlanPayload: AssertWire<typeof cancelPlanPayloadSchema, CancelPlanPayload> = true;
const _getTasksPayload: AssertWire<typeof getTasksPayloadSchema, GetTasksPayload> = true;
// The wire task union mirrors the protocol `TaskInfo`; the engine's
// declaration-merged `AgentTaskInfo` is structurally identical but depends on
// tool-module augmentation, so parity is pinned to the protocol type.
const _agentTaskInfo: AssertWire<typeof agentTaskInfoSchema, TaskInfo> = true;
const _detachTaskInput: AssertTypeEqual<
  z.infer<typeof agentTaskContract.detach.input>,
  Parameters<IAgentTaskService['detach']>
> = true;
const _detachTaskResult: AssertWire<
  typeof agentTaskContract.detach.output,
  Awaited<ReturnType<IAgentTaskService['detach']>>
> = true;
const _stopTaskPayload: AssertWire<typeof stopTaskPayloadSchema, StopTaskPayload> = true;
const _getTaskOutputPayload: AssertWire<typeof getTaskOutputPayloadSchema, GetTaskOutputPayload> =
  true;

// ── agent scope (events.ts) ─────────────────────────────────────────────────
// Parity against the protocol event types (the stream carries flat
// `{ type, ... }` events; schemas keep the `type` literal). One-directional
// where a field is mirrored as `unknown`.
const _turnStartedEvent: AssertEngineToWire<typeof turnStartedEventSchema, TurnStartedEvent> = true;
const _turnEndedEvent: AssertEngineToWire<typeof turnEndedEventSchema, TurnEndedEvent> = true;
const _turnStepStartedEvent: AssertWire<
  typeof turnStepStartedEventSchema,
  TurnStepStartedEvent
> = true;
const _turnStepRetryingEvent: AssertWire<
  typeof turnStepRetryingEventSchema,
  TurnStepRetryingEvent
> = true;
const _turnStepInterruptedEvent: AssertWire<
  typeof turnStepInterruptedEventSchema,
  TurnStepInterruptedEvent
> = true;
const _turnStepCompletedEvent: AssertWire<
  typeof turnStepCompletedEventSchema,
  TurnStepCompletedEvent
> = true;
const _assistantDeltaEvent: AssertWire<typeof assistantDeltaEventSchema, AssistantDeltaEvent> =
  true;
const _hookResultEvent: AssertWire<typeof hookResultEventSchema, HookResultEvent> = true;
const _thinkingDeltaEvent: AssertWire<typeof thinkingDeltaEventSchema, ThinkingDeltaEvent> = true;
const _toolCallDeltaEvent: AssertWire<typeof toolCallDeltaEventSchema, ToolCallDeltaEvent> = true;
const _toolCallStartedEvent: AssertEngineToWire<
  typeof toolCallStartedEventSchema,
  ToolCallStartedEvent
> = true;
const _toolProgressEvent: AssertWire<typeof toolProgressEventSchema, ToolProgressEvent> = true;
const _shellOutputEvent: AssertWire<typeof shellOutputEventSchema, ShellOutputEvent> = true;
const _shellStartedEvent: AssertWire<typeof shellStartedEventSchema, ShellStartedEvent> = true;
const _toolResultEvent: AssertWire<typeof toolResultEventSchema, ToolResultEvent> = true;
const _promptCompletedEvent: AssertWire<typeof promptCompletedEventSchema, PromptCompletedEvent> =
  true;
const _promptAbortedEvent: AssertWire<typeof promptAbortedEventSchema, PromptAbortedEvent> = true;
const _goalUpdatedEvent: AssertWire<typeof goalUpdatedEventSchema, GoalUpdatedEvent> = true;
const _skillActivatedEvent: AssertWire<typeof skillActivatedEventSchema, SkillActivatedEvent> =
  true;
const _pluginCommandActivatedEvent: AssertWire<
  typeof pluginCommandActivatedEventSchema,
  PluginCommandActivatedEvent
> = true;
const _warningEvent: AssertWire<typeof warningEventSchema, WarningEvent> = true;
const _noticeEvent: AssertWire<typeof noticeEventSchema, NoticeEvent> = true;
const _compactionStartedEvent: AssertWire<
  typeof compactionStartedEventSchema,
  CompactionStartedEvent
> = true;
const _compactionBlockedEvent: AssertWire<
  typeof compactionBlockedEventSchema,
  CompactionBlockedEvent
> = true;
const _compactionCancelledEvent: AssertWire<
  typeof compactionCancelledEventSchema,
  CompactionCancelledEvent
> = true;
const _compactionCompletedEvent: AssertWire<
  typeof compactionCompletedEventSchema,
  CompactionCompletedEvent
> = true;
const _subagentSpawnedEvent: AssertWire<
  typeof subagentSpawnedEventSchema,
  SubagentSpawnedEvent
> = true;
const _subagentStartedEvent: AssertWire<
  typeof subagentStartedEventSchema,
  SubagentStartedEvent
> = true;
const _subagentSuspendedEvent: AssertWire<
  typeof subagentSuspendedEventSchema,
  SubagentSuspendedEvent
> = true;
const _subagentCompletedEvent: AssertWire<
  typeof subagentCompletedEventSchema,
  SubagentCompletedEvent
> = true;
const _subagentFailedEvent: AssertWire<typeof subagentFailedEventSchema, SubagentFailedEvent> =
  true;
const _taskStartedEvent: AssertWire<typeof taskStartedEventSchema, TaskStartedEvent> = true;
const _taskTerminatedEvent: AssertWire<
  typeof taskTerminatedEventSchema,
  TaskTerminatedEvent
> = true;
const _cronFiredEvent: AssertWire<typeof cronFiredEventSchema, CronFiredEvent> = true;
const _mcpServerStatusEvent: AssertWire<
  typeof mcpServerStatusEventSchema,
  McpServerStatusEvent
> = true;
const _toolListUpdatedEvent: AssertWire<
  typeof toolListUpdatedEventSchema,
  ToolListUpdatedEvent
> = true;
// No parity assertions for `errorEventSchema`, `permissionApproval*Schema`,
// and `agentStatusUpdatedEventSchema`: they are deliberately `z.looseObject`s
// (index signature breaks both-ways assignability) — `permission.approval.*`
// is not part of the protocol event union at all.
