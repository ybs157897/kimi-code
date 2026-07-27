/**
 * Klient-level agent-scope events — the public, typed, namespaced event
 * surface of one agent. All registrations filter the per-agent `events`
 * scope stream by `type`; the payload is the whole flat `{ type, ... }`
 * event (schemas keep the `type` literal so listeners receive it intact).
 * Payload shapes mirror `protocol/src/events.ts`; events that are loose in
 * the engine (or absent from the protocol union) are `z.looseObject`s.
 */

import { z } from 'zod';

import type { EventRegistration } from '../types.js';
import { goalSnapshotSchema, goalStatusSchema } from './goal.js';
import { agentTaskInfoSchema, tokenUsageSchema } from './rpc.js';

/**
 * Scope-stream registration (`kind: 'stream'`). Declared structurally here
 * until `EventRegistration` in `../types.js` gains the `stream` variant;
 * compatible with `src/core/events/hub.ts`, which already switches on it.
 */
interface StreamEventRegistration {
  readonly kind: 'stream';
  readonly name: string;
  readonly type?: string;
  readonly schema: z.ZodType;
}

type AgentEventRegistration = EventRegistration | StreamEventRegistration;

// ── payload schemas ─────────────────────────────────────────────────────────

export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  turnId: z.number(),
  /** Protocol `PromptOrigin` union — mirrored as `unknown`. */
  origin: z.unknown(),
  /** The turn's extracted prompt text (present when the turn opened with a text part). */
  prompt: z.string().optional(),
});

export const turnEndedEventSchema = z.object({
  type: z.literal('turn.ended'),
  turnId: z.number(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  /** Protocol `KimiErrorPayload` — mirrored as `unknown`. */
  error: z.unknown().optional(),
  durationMs: z.number().optional(),
});

export const turnStepStartedEventSchema = z.object({
  type: z.literal('turn.step.started'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
});

export const turnStepRetryingEventSchema = z.object({
  type: z.literal('turn.step.retrying'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
});

export const turnStepInterruptedEventSchema = z.object({
  type: z.literal('turn.step.interrupted'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  reason: z.string(),
  message: z.string().optional(),
});

export const turnStepCompletedEventSchema = z.object({
  type: z.literal('turn.step.completed'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  finishReason: z.string().optional(),
  llmFirstTokenLatencyMs: z.number().optional(),
  llmStreamDurationMs: z.number().optional(),
  llmRequestBuildMs: z.number().optional(),
  llmServerFirstTokenMs: z.number().optional(),
  llmServerDecodeMs: z.number().optional(),
  llmClientConsumeMs: z.number().optional(),
  providerFinishReason: z
    .enum(['completed', 'tool_calls', 'truncated', 'filtered', 'paused', 'other'])
    .optional(),
  rawFinishReason: z.string().optional(),
});

export const assistantDeltaEventSchema = z.object({
  type: z.literal('assistant.delta'),
  turnId: z.number(),
  delta: z.string(),
});

export const hookResultEventSchema = z.object({
  type: z.literal('hook.result'),
  turnId: z.number().optional(),
  hookEvent: z.string(),
  content: z.string(),
  blocked: z.boolean().optional(),
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal('thinking.delta'),
  turnId: z.number(),
  delta: z.string(),
});

export const toolCallDeltaEventSchema = z.object({
  type: z.literal('tool.call.delta'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string().optional(),
  argumentsPart: z.string().optional(),
});

export const toolCallStartedEventSchema = z.object({
  type: z.literal('tool.call.started'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  description: z.string().optional(),
  /** Protocol `ToolInputDisplay` — mirrored as `unknown`. */
  display: z.unknown().optional(),
});

export const toolProgressEventSchema = z.object({
  type: z.literal('tool.progress'),
  turnId: z.number(),
  toolCallId: z.string(),
  update: z.object({
    kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
    text: z.string().optional(),
    percent: z.number().optional(),
    customKind: z.string().optional(),
    customData: z.unknown().optional(),
  }),
});

export const shellOutputEventSchema = z.object({
  type: z.literal('shell.output'),
  commandId: z.string(),
  update: z.object({
    kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
    text: z.string().optional(),
    percent: z.number().optional(),
    customKind: z.string().optional(),
    customData: z.unknown().optional(),
  }),
  taskId: z.string().optional(),
});

export const shellStartedEventSchema = z.object({
  type: z.literal('shell.started'),
  commandId: z.string(),
  taskId: z.string(),
});

export const toolResultEventSchema = z.object({
  type: z.literal('tool.result'),
  turnId: z.number(),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  synthetic: z.boolean().optional(),
});

export const promptCompletedEventSchema = z.object({
  type: z.literal('prompt.completed'),
  promptId: z.string(),
  /** ISO 8601 datetime string on the wire. */
  finishedAt: z.string(),
  reason: z.enum(['completed', 'failed', 'blocked']).optional(),
});

export const promptAbortedEventSchema = z.object({
  type: z.literal('prompt.aborted'),
  promptId: z.string(),
  /** ISO 8601 datetime string on the wire. */
  abortedAt: z.string(),
});

export const goalUpdatedEventSchema = z.object({
  type: z.literal('goal.updated'),
  snapshot: goalSnapshotSchema.nullable(),
  change: z
    .object({
      kind: z.enum(['lifecycle', 'completion']),
      status: goalStatusSchema.optional(),
      reason: z.string().optional(),
      stats: z
        .object({
          turnsUsed: z.number(),
          tokensUsed: z.number(),
          wallClockMs: z.number(),
        })
        .optional(),
      actor: z.enum(['user', 'model', 'runtime', 'system']).optional(),
    })
    .optional(),
});

export const skillActivatedEventSchema = z.object({
  type: z.literal('skill.activated'),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
  skillPath: z.string().optional(),
  skillSource: z.enum(['project', 'user', 'extra', 'builtin']).optional(),
});

export const pluginCommandActivatedEventSchema = z.object({
  type: z.literal('plugin_command.activated'),
  activationId: z.string(),
  pluginId: z.string(),
  commandName: z.string(),
  commandArgs: z.string().optional(),
  trigger: z.literal('user-slash'),
});

/** Engine `permission.approval.requested` — not in the protocol union; loose. */
export const permissionApprovalRequestedEventSchema = z.looseObject({
  turnId: z.number(),
  toolCallId: z.string(),
  toolName: z.string(),
  action: z.string(),
});

/** Engine `permission.approval.resolved` — not in the protocol union; loose. */
export const permissionApprovalResolvedEventSchema = z.looseObject({
  turnId: z.number(),
  toolCallId: z.string(),
});

/** `error` payloads carry the full `KimiErrorPayload`; kept loose. */
export const errorEventSchema = z.looseObject({
  message: z.string(),
});

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  message: z.string(),
  code: z.string().optional(),
});

export const noticeEventSchema = z.object({
  type: z.literal('notice'),
  message: z.string(),
  code: z.string().optional(),
});

/** `agent.status.updated` carries a wide optional status bag; kept loose. */
export const agentStatusUpdatedEventSchema = z.looseObject({
  phase: z.string().optional(),
});

export const compactionStartedEventSchema = z.object({
  type: z.literal('compaction.started'),
  trigger: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const compactionBlockedEventSchema = z.object({
  type: z.literal('compaction.blocked'),
  turnId: z.number().optional(),
});

export const compactionCancelledEventSchema = z.object({
  type: z.literal('compaction.cancelled'),
});

export const compactionCompletedEventSchema = z.object({
  type: z.literal('compaction.completed'),
  result: z.object({
    summary: z.string(),
    compactedCount: z.number(),
    tokensBefore: z.number(),
    tokensAfter: z.number(),
    keptUserMessageCount: z.number().optional(),
    keptHeadUserMessageCount: z.number().optional(),
    droppedCount: z.number().optional(),
  }),
});

export const subagentSpawnedEventSchema = z.object({
  type: z.literal('subagent.spawned'),
  subagentId: z.string(),
  subagentName: z.string(),
  parentToolCallId: z.string(),
  parentToolCallUuid: z.string().optional(),
  parentAgentId: z.string().optional(),
  callerAgentId: z.string().optional(),
  description: z.string().optional(),
  swarmIndex: z.number().optional(),
  runInBackground: z.boolean(),
});

export const subagentStartedEventSchema = z.object({
  type: z.literal('subagent.started'),
  subagentId: z.string(),
});

export const subagentSuspendedEventSchema = z.object({
  type: z.literal('subagent.suspended'),
  subagentId: z.string(),
  reason: z.string(),
});

export const subagentCompletedEventSchema = z.object({
  type: z.literal('subagent.completed'),
  subagentId: z.string(),
  resultSummary: z.string(),
  usage: tokenUsageSchema.optional(),
  contextTokens: z.number().optional(),
});

export const subagentFailedEventSchema = z.object({
  type: z.literal('subagent.failed'),
  subagentId: z.string(),
  error: z.string(),
});

export const taskStartedEventSchema = z.object({
  type: z.literal('task.started'),
  info: agentTaskInfoSchema,
});

export const taskTerminatedEventSchema = z.object({
  type: z.literal('task.terminated'),
  info: agentTaskInfoSchema,
});

export const cronFiredEventSchema = z.object({
  type: z.literal('cron.fired'),
  origin: z.object({
    kind: z.literal('cron_job'),
    jobId: z.string(),
    cron: z.string(),
    recurring: z.boolean(),
    coalescedCount: z.number(),
    stale: z.boolean(),
  }),
  prompt: z.string(),
});

export const mcpServerStatusEventSchema = z.object({
  type: z.literal('mcp.server.status'),
  server: z.object({
    name: z.string(),
    transport: z.enum(['stdio', 'http', 'sse']),
    status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth']),
    toolCount: z.number(),
    error: z.string().optional(),
  }),
});

export const toolListUpdatedEventSchema = z.object({
  type: z.literal('tool.list.updated'),
  reason: z.enum(['mcp.connected', 'mcp.disconnected', 'mcp.failed']),
  serverName: z.string(),
});

// ── registrations ───────────────────────────────────────────────────────────

/** Public event name → payload type. Keys must stay in sync with `agentEvents`. */
export interface AgentEventPayloads {
  'turn.started': z.infer<typeof turnStartedEventSchema>;
  'turn.ended': z.infer<typeof turnEndedEventSchema>;
  'turn.step.started': z.infer<typeof turnStepStartedEventSchema>;
  'turn.step.retrying': z.infer<typeof turnStepRetryingEventSchema>;
  'turn.step.interrupted': z.infer<typeof turnStepInterruptedEventSchema>;
  'turn.step.completed': z.infer<typeof turnStepCompletedEventSchema>;
  'assistant.delta': z.infer<typeof assistantDeltaEventSchema>;
  'hook.result': z.infer<typeof hookResultEventSchema>;
  'thinking.delta': z.infer<typeof thinkingDeltaEventSchema>;
  'tool.call.delta': z.infer<typeof toolCallDeltaEventSchema>;
  'tool.call.started': z.infer<typeof toolCallStartedEventSchema>;
  'tool.progress': z.infer<typeof toolProgressEventSchema>;
  'shell.output': z.infer<typeof shellOutputEventSchema>;
  'shell.started': z.infer<typeof shellStartedEventSchema>;
  'tool.result': z.infer<typeof toolResultEventSchema>;
  'prompt.completed': z.infer<typeof promptCompletedEventSchema>;
  'prompt.aborted': z.infer<typeof promptAbortedEventSchema>;
  'goal.updated': z.infer<typeof goalUpdatedEventSchema>;
  'skill.activated': z.infer<typeof skillActivatedEventSchema>;
  'plugin_command.activated': z.infer<typeof pluginCommandActivatedEventSchema>;
  'permission.approval.requested': z.infer<typeof permissionApprovalRequestedEventSchema>;
  'permission.approval.resolved': z.infer<typeof permissionApprovalResolvedEventSchema>;
  error: z.infer<typeof errorEventSchema>;
  warning: z.infer<typeof warningEventSchema>;
  notice: z.infer<typeof noticeEventSchema>;
  'agent.status.updated': z.infer<typeof agentStatusUpdatedEventSchema>;
  'compaction.started': z.infer<typeof compactionStartedEventSchema>;
  'compaction.blocked': z.infer<typeof compactionBlockedEventSchema>;
  'compaction.cancelled': z.infer<typeof compactionCancelledEventSchema>;
  'compaction.completed': z.infer<typeof compactionCompletedEventSchema>;
  'subagent.spawned': z.infer<typeof subagentSpawnedEventSchema>;
  'subagent.started': z.infer<typeof subagentStartedEventSchema>;
  'subagent.suspended': z.infer<typeof subagentSuspendedEventSchema>;
  'subagent.completed': z.infer<typeof subagentCompletedEventSchema>;
  'subagent.failed': z.infer<typeof subagentFailedEventSchema>;
  'task.started': z.infer<typeof taskStartedEventSchema>;
  'task.terminated': z.infer<typeof taskTerminatedEventSchema>;
  'cron.fired': z.infer<typeof cronFiredEventSchema>;
  'mcp.server.status': z.infer<typeof mcpServerStatusEventSchema>;
  'tool.list.updated': z.infer<typeof toolListUpdatedEventSchema>;
}

export type AgentEventName = keyof AgentEventPayloads;

/** Public event name → stream binding + payload schema. */
export const agentEvents = {
  'turn.started': { kind: 'stream', name: 'events', type: 'turn.started', schema: turnStartedEventSchema },
  'turn.ended': { kind: 'stream', name: 'events', type: 'turn.ended', schema: turnEndedEventSchema },
  'turn.step.started': {
    kind: 'stream',
    name: 'events',
    type: 'turn.step.started',
    schema: turnStepStartedEventSchema,
  },
  'turn.step.retrying': {
    kind: 'stream',
    name: 'events',
    type: 'turn.step.retrying',
    schema: turnStepRetryingEventSchema,
  },
  'turn.step.interrupted': {
    kind: 'stream',
    name: 'events',
    type: 'turn.step.interrupted',
    schema: turnStepInterruptedEventSchema,
  },
  'turn.step.completed': {
    kind: 'stream',
    name: 'events',
    type: 'turn.step.completed',
    schema: turnStepCompletedEventSchema,
  },
  'assistant.delta': { kind: 'stream', name: 'events', type: 'assistant.delta', schema: assistantDeltaEventSchema },
  'hook.result': {
    kind: 'stream',
    name: 'events',
    type: 'hook.result',
    schema: hookResultEventSchema,
  },
  'thinking.delta': { kind: 'stream', name: 'events', type: 'thinking.delta', schema: thinkingDeltaEventSchema },
  'tool.call.delta': {
    kind: 'stream',
    name: 'events',
    type: 'tool.call.delta',
    schema: toolCallDeltaEventSchema,
  },
  'tool.call.started': { kind: 'stream', name: 'events', type: 'tool.call.started', schema: toolCallStartedEventSchema },
  'tool.progress': {
    kind: 'stream',
    name: 'events',
    type: 'tool.progress',
    schema: toolProgressEventSchema,
  },
  'shell.output': {
    kind: 'stream',
    name: 'events',
    type: 'shell.output',
    schema: shellOutputEventSchema,
  },
  'shell.started': {
    kind: 'stream',
    name: 'events',
    type: 'shell.started',
    schema: shellStartedEventSchema,
  },
  'tool.result': { kind: 'stream', name: 'events', type: 'tool.result', schema: toolResultEventSchema },
  'prompt.completed': { kind: 'stream', name: 'events', type: 'prompt.completed', schema: promptCompletedEventSchema },
  'prompt.aborted': { kind: 'stream', name: 'events', type: 'prompt.aborted', schema: promptAbortedEventSchema },
  'goal.updated': {
    kind: 'stream',
    name: 'events',
    type: 'goal.updated',
    schema: goalUpdatedEventSchema,
  },
  'skill.activated': {
    kind: 'stream',
    name: 'events',
    type: 'skill.activated',
    schema: skillActivatedEventSchema,
  },
  'plugin_command.activated': {
    kind: 'stream',
    name: 'events',
    type: 'plugin_command.activated',
    schema: pluginCommandActivatedEventSchema,
  },
  'permission.approval.requested': {
    kind: 'stream',
    name: 'events',
    type: 'permission.approval.requested',
    schema: permissionApprovalRequestedEventSchema,
  },
  'permission.approval.resolved': {
    kind: 'stream',
    name: 'events',
    type: 'permission.approval.resolved',
    schema: permissionApprovalResolvedEventSchema,
  },
  error: { kind: 'stream', name: 'events', type: 'error', schema: errorEventSchema },
  warning: { kind: 'stream', name: 'events', type: 'warning', schema: warningEventSchema },
  notice: { kind: 'stream', name: 'events', type: 'notice', schema: noticeEventSchema },
  'agent.status.updated': {
    kind: 'stream',
    name: 'events',
    type: 'agent.status.updated',
    schema: agentStatusUpdatedEventSchema,
  },
  'compaction.started': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.started',
    schema: compactionStartedEventSchema,
  },
  'compaction.blocked': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.blocked',
    schema: compactionBlockedEventSchema,
  },
  'compaction.cancelled': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.cancelled',
    schema: compactionCancelledEventSchema,
  },
  'compaction.completed': {
    kind: 'stream',
    name: 'events',
    type: 'compaction.completed',
    schema: compactionCompletedEventSchema,
  },
  'subagent.spawned': {
    kind: 'stream',
    name: 'events',
    type: 'subagent.spawned',
    schema: subagentSpawnedEventSchema,
  },
  'subagent.started': {
    kind: 'stream',
    name: 'events',
    type: 'subagent.started',
    schema: subagentStartedEventSchema,
  },
  'subagent.suspended': {
    kind: 'stream',
    name: 'events',
    type: 'subagent.suspended',
    schema: subagentSuspendedEventSchema,
  },
  'subagent.completed': {
    kind: 'stream',
    name: 'events',
    type: 'subagent.completed',
    schema: subagentCompletedEventSchema,
  },
  'subagent.failed': {
    kind: 'stream',
    name: 'events',
    type: 'subagent.failed',
    schema: subagentFailedEventSchema,
  },
  'task.started': {
    kind: 'stream',
    name: 'events',
    type: 'task.started',
    schema: taskStartedEventSchema,
  },
  'task.terminated': {
    kind: 'stream',
    name: 'events',
    type: 'task.terminated',
    schema: taskTerminatedEventSchema,
  },
  'cron.fired': {
    kind: 'stream',
    name: 'events',
    type: 'cron.fired',
    schema: cronFiredEventSchema,
  },
  'mcp.server.status': {
    kind: 'stream',
    name: 'events',
    type: 'mcp.server.status',
    schema: mcpServerStatusEventSchema,
  },
  'tool.list.updated': {
    kind: 'stream',
    name: 'events',
    type: 'tool.list.updated',
    schema: toolListUpdatedEventSchema,
  },
} satisfies Record<AgentEventName, AgentEventRegistration>;
