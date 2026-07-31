import { z } from 'zod';

import {
  permissionModeSchema,
  skillSourceSchema,
  turnEndReasonSchema,
  usageStatusSchema,
  type PermissionMode,
  type SkillSource,
  type TurnEndReason,
  type UsageStatus,
} from './base';
import { messageContentSchema, type MessageContent } from '../message';
import {
  providerRefreshChangeSchema,
  providerRefreshFailureSchema,
  type ProviderRefreshChange,
  type ProviderRefreshFailure,
} from '../modelCatalog';
import { configResponseSchema, type ConfigResponse } from '../rest/config';
import {
  sessionPendingInteractionSchema,
  sessionSchema,
  type Session,
  type SessionPendingInteraction,
} from '../session';
import { isoDateTimeSchema } from '../time';
import { workspaceSchema, type Workspace } from '../workspace';

export type AgentPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly since: number;
    }
  | {
      readonly kind: 'streaming';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly stream: 'assistant' | 'thinking' | 'tool_call';
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly since: number;
    }
  | {
      readonly kind: 'tool_call';
      readonly turnId: number;
      readonly step: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly since: number;
    }
  | {
      readonly kind: 'retrying';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName?: string;
      readonly statusCode?: number;
      readonly since: number;
    }
  | {
      readonly kind: 'awaiting_approval';
      readonly turnId: number;
      readonly step?: number;
      readonly approval?: unknown;
      readonly since: number;
    }
  | {
      readonly kind: 'interrupted';
      readonly turnId: number;
      readonly step?: number;
      readonly reason: 'aborted' | 'max_steps' | 'error';
      readonly message?: string;
      readonly at: number;
    }
  | {
      readonly kind: 'ended';
      readonly turnId: number;
      readonly reason: TurnEndReason;
      readonly durationMs?: number;
      readonly at: number;
    };

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly permission?: PermissionMode;
  readonly usage?: UsageStatus;
  readonly phase?: AgentPhase;
}

export interface SessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly title?: string;
  readonly patch?: Record<string, unknown>;
}

export type ExpertTeamMemberPhase = 'not_started' | 'idle' | 'running';

export interface ExpertTeamMemberState {
  readonly name: string;
  readonly agentId?: string;
  readonly status: ExpertTeamMemberPhase;
}

export interface ExpertTeamStatusSnapshot {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly leadAgentName: string;
  readonly activatedAt: string;
  readonly members: readonly ExpertTeamMemberState[];
}

export interface ExpertTeamUpdatedEvent {
  readonly type: 'expert_team.updated';
  readonly status: ExpertTeamStatusSnapshot | null;
}

export interface SessionCreatedEvent {
  readonly type: 'event.session.created';
  readonly session: Session;
}

export interface WorkspaceCreatedEvent {
  readonly type: 'event.workspace.created';
  readonly workspace: Workspace;
}

export interface WorkspaceUpdatedEvent {
  readonly type: 'event.workspace.updated';
  readonly workspace: Workspace;
}

export interface WorkspaceDeletedEvent {
  readonly type: 'event.workspace.deleted';
  readonly workspace_id: string;
  readonly root: string;
}

export interface SessionWorkChangedEvent {
  readonly type: 'event.session.work_changed';
  readonly busy: boolean;
  /** Main-agent turn liveness, excluding background and sub-agent work. */
  readonly main_turn_active?: boolean;
  /** Highest-priority pending interaction for clients without a session subscription. */
  readonly pending_interaction?: SessionPendingInteraction;
  /** Outcome of the MAIN agent's most recent turn, when one has ended since
   *  activation (see `Session.last_turn_reason`). */
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}

/**
 * @deprecated Replaced by {@link SessionWorkChangedEvent}: awaiting states
 * ride the approval/question channels and outcomes ride turn.ended. Kept so
 * pre-change journals still parse during replay.
 */
export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly previous_status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly current_prompt_id?: string;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

/**
 * Pushed when the daemon refreshes provider model metadata (manual or
 * scheduled) and the effective catalog changed. Carries the per-provider
 * diff so clients can both refresh their model/provider caches and surface a
 * summary ("3 models added") without re-diffing the whole config.
 */
export interface ModelCatalogChangedEvent {
  readonly type: 'event.model_catalog.changed';
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
}

export interface SkillActivatedEvent {
  readonly type: 'skill.activated';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface PluginCommandActivatedEvent {
  readonly type: 'plugin_command.activated';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

export interface PromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued' | 'blocked';
  readonly content: readonly MessageContent[];
  readonly createdAt: string;
}

export interface PromptCompletedEvent {
  readonly type: 'prompt.completed';
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason?: 'completed' | 'failed' | 'blocked';
}

export interface PromptAbortedEvent {
  readonly type: 'prompt.aborted';
  readonly promptId: string;
  readonly abortedAt: string;
}

export interface PromptSteeredEvent {
  readonly type: 'prompt.steered';
  readonly activePromptId: string;
  readonly promptIds: readonly string[];
  readonly content: readonly MessageContent[];
  readonly steeredAt: string;
}

export const agentPhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('running'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('streaming'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    stream: z.enum(['assistant', 'thinking', 'tool_call']),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('tool_call'),
    turnId: z.number(),
    step: z.number(),
    toolCallId: z.string(),
    name: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('retrying'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    failedAttempt: z.number(),
    nextAttempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorName: z.string().optional(),
    statusCode: z.number().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('awaiting_approval'),
    turnId: z.number(),
    step: z.number().optional(),
    approval: z.unknown().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('interrupted'),
    turnId: z.number(),
    step: z.number().optional(),
    reason: z.enum(['aborted', 'max_steps', 'error']),
    message: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('ended'),
    turnId: z.number(),
    reason: turnEndReasonSchema,
    durationMs: z.number().optional(),
    at: z.number(),
  }),
]) satisfies z.ZodType<AgentPhase>;

export const agentStatusUpdatedEventSchema = z.object({
  type: z.literal('agent.status.updated'),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  planMode: z.boolean().optional(),
  swarmMode: z.boolean().optional(),
  permission: permissionModeSchema.optional(),
  usage: usageStatusSchema.optional(),
  phase: agentPhaseSchema.optional(),
}) satisfies z.ZodType<AgentStatusUpdatedEvent>;

export const sessionMetaUpdatedEventSchema = z.object({
  type: z.literal('session.meta.updated'),
  title: z.string().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<SessionMetaUpdatedEvent>;

export const expertTeamMemberStateSchema = z.object({
  name: z.string().min(1),
  agentId: z.string().min(1).optional(),
  status: z.enum(['not_started', 'idle', 'running']),
}) satisfies z.ZodType<ExpertTeamMemberState>;

export const expertTeamStatusSnapshotSchema = z.object({
  pluginId: z.string().min(1),
  pluginVersion: z.string().min(1).optional(),
  displayName: z.string().min(1),
  leadAgentName: z.string().min(1),
  activatedAt: z.string().min(1),
  members: z.array(expertTeamMemberStateSchema),
}) satisfies z.ZodType<ExpertTeamStatusSnapshot>;

export const expertTeamUpdatedEventSchema = z.object({
  type: z.literal('expert_team.updated'),
  status: expertTeamStatusSnapshotSchema.nullable(),
}) satisfies z.ZodType<ExpertTeamUpdatedEvent>;

export const sessionCreatedEventSchema = z.object({
  type: z.literal('event.session.created'),
  session: sessionSchema,
}) satisfies z.ZodType<SessionCreatedEvent>;

export const workspaceCreatedEventSchema = z.object({
  type: z.literal('event.workspace.created'),
  workspace: workspaceSchema,
}) satisfies z.ZodType<WorkspaceCreatedEvent>;

export const workspaceUpdatedEventSchema = z.object({
  type: z.literal('event.workspace.updated'),
  workspace: workspaceSchema,
}) satisfies z.ZodType<WorkspaceUpdatedEvent>;

export const workspaceDeletedEventSchema = z.object({
  type: z.literal('event.workspace.deleted'),
  workspace_id: z.string().min(1),
  root: z.string().min(1),
}) satisfies z.ZodType<WorkspaceDeletedEvent>;

export const sessionWorkChangedEventSchema = z.object({
  type: z.literal('event.session.work_changed'),
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
}) satisfies z.ZodType<SessionWorkChangedEvent>;

/** @deprecated See {@link SessionStatusChangedEvent}. */
export const sessionStatusChangedEventSchema = z.object({
  type: z.literal('event.session.status_changed'),
  status: z.enum(['idle', 'running', 'awaiting_approval', 'awaiting_question', 'aborted']),
  previous_status: z.enum(['idle', 'running', 'awaiting_approval', 'awaiting_question', 'aborted']),
  current_prompt_id: z.string().min(1).optional(),
}) satisfies z.ZodType<SessionStatusChangedEvent>;

export const configChangedEventSchema = z.object({
  type: z.literal('event.config.changed'),
  changedFields: z.array(z.string()),
  config: configResponseSchema,
}) satisfies z.ZodType<ConfigChangedEvent>;

export const modelCatalogChangedEventSchema = z.object({
  type: z.literal('event.model_catalog.changed'),
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
}) satisfies z.ZodType<ModelCatalogChangedEvent>;

export const skillActivatedEventSchema = z.object({
  type: z.literal('skill.activated'),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
  skillPath: z.string().optional(),
  skillSource: skillSourceSchema.optional(),
}) satisfies z.ZodType<SkillActivatedEvent>;

export const pluginCommandActivatedEventSchema = z.object({
  type: z.literal('plugin_command.activated'),
  activationId: z.string(),
  pluginId: z.string(),
  commandName: z.string(),
  commandArgs: z.string().optional(),
  trigger: z.literal('user-slash'),
}) satisfies z.ZodType<PluginCommandActivatedEvent>;

export const promptSubmittedEventSchema = z.object({
  type: z.literal('prompt.submitted'),
  promptId: z.string(),
  userMessageId: z.string(),
  status: z.enum(['running', 'queued', 'blocked']),
  content: z.array(messageContentSchema),
  createdAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptSubmittedEvent>;

export const promptCompletedEventSchema = z.object({
  type: z.literal('prompt.completed'),
  promptId: z.string(),
  finishedAt: isoDateTimeSchema,
  reason: z.enum(['completed', 'failed', 'blocked']).optional(),
}) satisfies z.ZodType<PromptCompletedEvent>;

export const promptAbortedEventSchema = z.object({
  type: z.literal('prompt.aborted'),
  promptId: z.string(),
  abortedAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptAbortedEvent>;

export const promptSteeredEventSchema = z.object({
  type: z.literal('prompt.steered'),
  activePromptId: z.string(),
  promptIds: z.array(z.string()),
  content: z.array(messageContentSchema),
  steeredAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptSteeredEvent>;
