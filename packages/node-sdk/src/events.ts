/**
 * SDK event and reverse-RPC type surface.
 *
 * The wire event contract (`Event` union and every member interface) is owned
 * by `@moonshot-ai/protocol` — the single source of truth shared with the
 * engine (`agent-core-v2`) and every client. This module re-exports it so the
 * SDK public API (`#/index`) keeps its historical `Event` name and so consumers
 * branch on the same `type` literals the engine emits. Aligning here (instead
 * of mirroring the shapes by hand) removes the drift that left the SDK spelling
 * event names (`toolcall.*`, `tool_list.*`) and fields (`content` vs `delta`,
 * missing `turnId`) differently from the engine.
 *
 * The reverse-RPC payloads below (`ToolCallRequest`, `ToolCallResponse`,
 * `ToolUpdate`, `ApprovalHandler`, `QuestionHandler`) are SDK-local: they
 * describe the SDK's own tool/approval/question call surface, which is not part
 * of the streamed `Event` contract and so has no protocol counterpart.
 */

import type {
  Event as ProtocolEvent,
  ToolInputDisplay as ProtocolToolInputDisplay,
  ToolUpdate as ProtocolToolUpdate,
  TurnEndReason as ProtocolTurnEndReason,
} from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// Event union — re-exported from the protocol package (single source of truth).
// Each member carries `agentId` and `sessionId` via the `Event` intersection in
// `protocol/src/events.ts`, matching what a live runtime emits over the wire.
// ---------------------------------------------------------------------------

/**
 * Union of every event a Kimi Code runtime can emit. Consumers branch on
 * `event.type` to narrow. Mirrors `protocol`'s `Event` 1:1.
 */
export type Event = ProtocolEvent;

// Re-export the member interfaces so consumers can name them directly
// (`AssistantDeltaEvent`, `ToolCallStartedEvent`, …) the way they historically
// could. All of these originate in `@moonshot-ai/protocol`.
export type {
  AgentStatusUpdatedEvent,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  ConfigChangedEvent,
  CronFiredEvent,
  ErrorEvent,
  ExpertTeamUpdatedEvent,
  GoalUpdatedEvent,
  HookResultEvent,
  McpServerStatusEvent,
  ModelCatalogChangedEvent,
  NoticeEvent,
  PluginCommandActivatedEvent,
  PromptAbortedEvent,
  PromptCompletedEvent,
  PromptSteeredEvent,
  PromptSubmittedEvent,
  SessionCreatedEvent,
  SessionMetaUpdatedEvent,
  SessionStatusChangedEvent,
  SessionWorkChangedEvent,
  ShellCompletedEvent,
  ShellOutputEvent,
  ShellStartedEvent,
  SkillActivatedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  ThinkingDeltaEvent,
  AssistantDeltaEvent,
  TaskStartedEvent,
  TaskTerminatedEvent,
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
  WorkspaceCreatedEvent,
  WorkspaceDeletedEvent,
  WorkspaceUpdatedEvent,
} from '@moonshot-ai/protocol';

// The engine-side tool-progress `update` shape, used by the streamed
// `tool.progress` / `shell.output` events. Re-exported under the same name so
// consumers reading event payloads see the protocol shape.
export type ToolUpdate = ProtocolToolUpdate;

// Shared event payload types re-exported from protocol so consumers can name
// them the way the historical SDK surface allowed.
export type ToolInputDisplay = ProtocolToolInputDisplay;
export type TurnEndReason = ProtocolTurnEndReason;

// ---------------------------------------------------------------------------
// Reverse-RPC payloads — SDK-local, not part of the streamed Event contract.
// ---------------------------------------------------------------------------

/** A tool-call request the SDK dispatches through its reverse-RPC channel. */
export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

/** The result the SDK expects back from a reverse-RPC tool call. */
export interface ToolCallResponse {
  readonly output: string;
  readonly isError?: boolean;
}

// ---------------------------------------------------------------------------
// v2 re-exports kept for backwards-compatible public names.
// ---------------------------------------------------------------------------

import {
  MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
  type McpOAuthAuthorizationUrlUpdateData,
} from '@moonshot-ai/agent-core-v2/agent/mcp/tools/auth';
export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE, type McpOAuthAuthorizationUrlUpdateData };

import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
export type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
};

/** A value or a promise of it — the return shape handlers may use. */
export type MaybePromise<T> = T | Promise<T>;

/** Reverse-RPC handler invoked when the runtime requests a tool approval. */
export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

/** Reverse-RPC handler invoked when the runtime poses a structured question. */
export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
