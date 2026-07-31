import { z } from 'zod';

import {
  errorEventSchema,
  noticeEventSchema,
  warningEventSchema,
  type ErrorEvent,
  type NoticeEvent,
  type WarningEvent,
} from './base';
import { goalUpdatedEventSchema, type GoalUpdatedEvent } from './goal';
import {
  agentStatusUpdatedEventSchema,
  expertTeamUpdatedEventSchema,
  modelCatalogChangedEventSchema,
  pluginCommandActivatedEventSchema,
  promptAbortedEventSchema,
  promptCompletedEventSchema,
  promptSteeredEventSchema,
  promptSubmittedEventSchema,
  sessionCreatedEventSchema,
  sessionMetaUpdatedEventSchema,
  sessionStatusChangedEventSchema,
  sessionWorkChangedEventSchema,
  skillActivatedEventSchema,
  workspaceCreatedEventSchema,
  workspaceDeletedEventSchema,
  workspaceUpdatedEventSchema,
  type AgentStatusUpdatedEvent,
  type ConfigChangedEvent,
  type ExpertTeamUpdatedEvent,
  type ModelCatalogChangedEvent,
  type PluginCommandActivatedEvent,
  type PromptAbortedEvent,
  type PromptCompletedEvent,
  type PromptSteeredEvent,
  type PromptSubmittedEvent,
  type SessionCreatedEvent,
  type SessionMetaUpdatedEvent,
  type SessionStatusChangedEvent,
  type SessionWorkChangedEvent,
  type SkillActivatedEvent,
  type WorkspaceCreatedEvent,
  type WorkspaceDeletedEvent,
  type WorkspaceUpdatedEvent,
} from './session';
import {
  backgroundTaskStartedEventSchema,
  backgroundTaskTerminatedEventSchema,
  cronFiredEventSchema,
  taskStartedEventSchema,
  taskTerminatedEventSchema,
  type BackgroundTaskStartedEvent,
  type BackgroundTaskTerminatedEvent,
  type CronFiredEvent,
  type TaskStartedEvent,
  type TaskTerminatedEvent,
} from './task';
import {
  mcpServerStatusEventSchema,
  shellCompletedEventSchema,
  shellOutputEventSchema,
  shellStartedEventSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolListUpdatedEventSchema,
  toolProgressEventSchema,
  toolResultEventSchema,
  type McpServerStatusEvent,
  type ShellCompletedEvent,
  type ShellOutputEvent,
  type ShellStartedEvent,
  type ToolCallDeltaEvent,
  type ToolCallStartedEvent,
  type ToolListUpdatedEvent,
  type ToolProgressEvent,
  type ToolResultEvent,
} from './tool';
import {
  assistantDeltaEventSchema,
  compactionBlockedEventSchema,
  compactionCancelledEventSchema,
  compactionCompletedEventSchema,
  compactionStartedEventSchema,
  hookResultEventSchema,
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  thinkingDeltaEventSchema,
  turnEndedEventSchema,
  turnStartedEventSchema,
  turnStepCompletedEventSchema,
  turnStepInterruptedEventSchema,
  turnStepRetryingEventSchema,
  turnStepStartedEventSchema,
  type AssistantDeltaEvent,
  type CompactionBlockedEvent,
  type CompactionCancelledEvent,
  type CompactionCompletedEvent,
  type CompactionStartedEvent,
  type HookResultEvent,
  type SubagentCompletedEvent,
  type SubagentFailedEvent,
  type SubagentSpawnedEvent,
  type SubagentStartedEvent,
  type SubagentSuspendedEvent,
  type ThinkingDeltaEvent,
  type TurnEndedEvent,
  type TurnStartedEvent,
  type TurnStepCompletedEvent,
  type TurnStepInterruptedEvent,
  type TurnStepRetryingEvent,
  type TurnStepStartedEvent,
} from './turn';

export type AgentEvent =
  | ErrorEvent
  | WarningEvent
  | NoticeEvent
  | AgentStatusUpdatedEvent
  | SessionMetaUpdatedEvent
  | ExpertTeamUpdatedEvent
  | SessionCreatedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionWorkChangedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | ModelCatalogChangedEvent
  | GoalUpdatedEvent
  | SkillActivatedEvent
  | PluginCommandActivatedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | TurnStepStartedEvent
  | TurnStepCompletedEvent
  | TurnStepRetryingEvent
  | TurnStepInterruptedEvent
  | AssistantDeltaEvent
  | HookResultEvent
  | ThinkingDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallStartedEvent
  | ToolProgressEvent
  | ShellOutputEvent
  | ShellStartedEvent
  | ShellCompletedEvent
  | ToolResultEvent
  | ToolListUpdatedEvent
  | McpServerStatusEvent
  | SubagentSpawnedEvent
  | SubagentStartedEvent
  | SubagentSuspendedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | CompactionStartedEvent
  | CompactionBlockedEvent
  | CompactionCancelledEvent
  | CompactionCompletedEvent
  | TaskStartedEvent
  | TaskTerminatedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | CronFiredEvent
  | PromptSubmittedEvent
  | PromptCompletedEvent
  | PromptAbortedEvent
  | PromptSteeredEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };

export const agentEventSchema = z.discriminatedUnion('type', [
  errorEventSchema,
  warningEventSchema,
  noticeEventSchema,
  agentStatusUpdatedEventSchema,
  sessionMetaUpdatedEventSchema,
  expertTeamUpdatedEventSchema,
  sessionCreatedEventSchema,
  workspaceCreatedEventSchema,
  workspaceUpdatedEventSchema,
  workspaceDeletedEventSchema,
  sessionWorkChangedEventSchema,
  sessionStatusChangedEventSchema,
  modelCatalogChangedEventSchema,
  goalUpdatedEventSchema,
  skillActivatedEventSchema,
  pluginCommandActivatedEventSchema,
  turnStartedEventSchema,
  turnEndedEventSchema,
  turnStepStartedEventSchema,
  turnStepCompletedEventSchema,
  turnStepRetryingEventSchema,
  turnStepInterruptedEventSchema,
  assistantDeltaEventSchema,
  hookResultEventSchema,
  thinkingDeltaEventSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolProgressEventSchema,
  shellOutputEventSchema,
  shellStartedEventSchema,
  shellCompletedEventSchema,
  toolResultEventSchema,
  toolListUpdatedEventSchema,
  mcpServerStatusEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  compactionStartedEventSchema,
  compactionBlockedEventSchema,
  compactionCancelledEventSchema,
  compactionCompletedEventSchema,
  taskStartedEventSchema,
  taskTerminatedEventSchema,
  backgroundTaskStartedEventSchema,
  backgroundTaskTerminatedEventSchema,
  cronFiredEventSchema,
  promptSubmittedEventSchema,
  promptCompletedEventSchema,
  promptAbortedEventSchema,
  promptSteeredEventSchema,
]) satisfies z.ZodType<AgentEvent>;

export const eventSchema = agentEventSchema.and(
  z.object({
    agentId: z.string(),
    sessionId: z.string(),
  }),
) satisfies z.ZodType<Event>;

/**
 * Volatile (ephemeral) event types — the IM-style "typing indicator" class.
 *
 * Volatile events are NOT journaled and do NOT advance the per-session
 * durable `seq`. They are fanned out live with the current durable watermark
 * (`seq` = last durable seq, `volatile: true` on the envelope) and are never
 * replayed after a reconnect. Clients recover any state they convey from the
 * session snapshot (`GET /sessions/{sid}/snapshot` → `in_flight_turn`) or
 * other REST surfaces instead of delta replay.
 *
 * Everything not listed here is durable: journaled, seq-bearing, replayable.
 *
 * @deprecated Use the server-side `isVolatileSignal`
 * (`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`) instead,
 * which owns volatile-vs-durable classification for the `wire` emission path.
 * The legacy `IAgentRecordService` (`record.on`) transport path still consumes
 * this until Phase 4 removes it; do not add new consumers.
 */
export const VOLATILE_EVENT_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
] as const satisfies readonly AgentEvent['type'][];

export type VolatileEventType = (typeof VOLATILE_EVENT_TYPES)[number];

const volatileEventTypeSet: ReadonlySet<string> = new Set(VOLATILE_EVENT_TYPES);

/**
 * @deprecated Use the server-side `isVolatileSignal`
 * (`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`) instead,
 * which owns volatile-vs-durable classification for the `wire` emission path.
 * Retained only for the legacy `IAgentRecordService` (`record.on`) transport
 * path until Phase 4 removes it; do not add new consumers.
 */
export function isVolatileEventType(type: string): type is VolatileEventType {
  return volatileEventTypeSet.has(type);
}
