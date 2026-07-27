/**
 * Agent-scope domain service contracts. These mirror the positional-arg
 * signatures of the engine's domain Services (shellCommand / profile / usage /
 * plan / task / replayView) that the agent facade calls directly; payload and
 * result schemas are shared with `agent/rpc.ts` where they mirror the same
 * wire shapes.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { approvalResponseSchema } from '../session/approval.js';
import { goalSnapshotSchema, goalStatusSchema } from './goal.js';
import {
  agentTaskInfoSchema,
  permissionModeSchema,
  planDataSchema,
  runShellCommandPayloadSchema,
  setModelResultSchema,
  shellCommandResultSchema,
  usageStatusSchema,
} from './rpc.js';

export const bindAgentInputSchema = z.object({
  profile: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  strictThinking: z.boolean().optional(),
  cwd: z.string().optional(),
});

export const thinkingLevelSchema = z.string();

export const modelCapabilitySchema = z.object({
  image_in: z.boolean(),
  video_in: z.boolean(),
  audio_in: z.boolean(),
  thinking: z.boolean(),
  tool_use: z.boolean(),
  max_context_tokens: z.number(),
  max_input_tokens: z.number().optional(),
  dynamically_loaded_tools: z.boolean().optional(),
});

export const profileDataSchema = z.object({
  cwd: z.string(),
  modelAlias: z.string().optional(),
  modelCapabilities: modelCapabilitySchema,
  profileName: z.string().optional(),
  thinkingLevel: thinkingLevelSchema,
  systemPrompt: z.string(),
  activeToolNames: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  subagents: z.array(z.string()).optional(),
});

export const fullCompactionInputSchema = z.object({
  source: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const agentFullCompactionContract = {
  begin: { input: z.tuple([fullCompactionInputSchema]), output: z.boolean() },
} satisfies ServiceContract;

export const mcpServerEntrySchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth']),
  toolCount: z.number(),
  error: z.string().optional(),
});

export const agentMcpContract = {
  list: { input: z.tuple([]), output: z.array(mcpServerEntrySchema) },
  initialLoadDurationMs: { input: z.tuple([]), output: z.number() },
  reconnect: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('think'),
    think: z.string(),
    encrypted: z.string().optional(),
  }),
  z.object({
    type: z.literal('image_url'),
    imageUrl: z.object({ url: z.string(), id: z.string().optional() }),
  }),
  z.object({
    type: z.literal('audio_url'),
    audioUrl: z.object({ url: z.string(), id: z.string().optional() }),
  }),
  z.object({
    type: z.literal('video_url'),
    videoUrl: z.object({ url: z.string(), id: z.string().optional() }),
  }),
]);

const toolCallSchema = z.object({
  type: z.literal('function'),
  id: z.string(),
  name: z.string(),
  arguments: z.string().nullable(),
  extras: z.record(z.string(), z.unknown()).optional(),
  _streamIndex: z.union([z.number(), z.string()]).optional(),
});

const messageToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  deferred: z.literal(true).optional(),
});

const promptOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({
    kind: z.literal('skill_activation'),
    activationId: z.string(),
    skillName: z.string(),
    skillArgs: z.string().optional(),
    trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
    skillType: z.string().optional(),
    skillPath: z.string().optional(),
    skillSource: z.enum(['project', 'user', 'extra', 'builtin']).optional(),
  }),
  z.object({
    kind: z.literal('plugin_command'),
    activationId: z.string(),
    pluginId: z.string(),
    commandName: z.string(),
    commandArgs: z.string().optional(),
    trigger: z.literal('user-slash'),
  }),
  z.object({
    kind: z.literal('injection'),
    variant: z.string(),
    ownerPromptId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('shell_command'),
    phase: z.enum(['input', 'output']),
    isError: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('compaction_summary') }),
  z.object({
    kind: z.literal('system_trigger'),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('task'),
    taskId: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
    notificationId: z.string(),
  }),
  z.object({
    kind: z.literal('cron_job'),
    jobId: z.string(),
    cron: z.string(),
    recurring: z.boolean(),
    coalescedCount: z.number(),
    stale: z.boolean(),
  }),
  z.object({
    kind: z.literal('cron_missed'),
    count: z.number(),
  }),
  z.object({
    kind: z.literal('hook_result'),
    event: z.string(),
    blocked: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('retry'),
    trigger: z.string().optional(),
  }),
  z.object({
    kind: z.literal('team_message'),
    teamId: z.string(),
    fromAgentId: z.string(),
    toAgentId: z.string(),
    messageType: z.enum(['message', 'shutdown_request', 'shutdown_response']),
  }),
]);

export const replayContextMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  name: z.string().optional(),
  content: z.array(contentPartSchema),
  toolCalls: z.array(toolCallSchema),
  toolCallId: z.string().optional(),
  partial: z.boolean().optional(),
  tools: z.array(messageToolSchema).optional(),
  id: z.string().optional(),
  providerMessageId: z.string().optional(),
  origin: promptOriginSchema.optional(),
  isError: z.boolean().optional(),
  note: z.string().optional(),
});

export const agentConfigDataSchema = z.object({
  cwd: z.string(),
  modelAlias: z.string().optional(),
  modelCapabilities: modelCapabilitySchema,
  profileName: z.string().optional(),
  thinkingLevel: z.string(),
  systemPrompt: z.string(),
});

const agentConfigUpdateDataSchema = z.object({
  cwd: z.string().optional(),
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  thinkingLevel: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const replayAgentContextDataSchema = z.object({
  history: z.array(replayContextMessageSchema),
  tokenCount: z.number(),
});

const compactionResultSchema = z.object({
  summary: z.string(),
  contextSummary: z.string().optional(),
  compactedCount: z.number(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  keptUserMessageCount: z.number().optional(),
  keptHeadUserMessageCount: z.number().optional(),
  droppedCount: z.number().optional(),
});

const goalChangeSchema = z.object({
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
});

const permissionApprovalResultRecordSchema = z.object({
  turnId: z.number(),
  toolCallId: z.string(),
  toolName: z.string(),
  action: z.string(),
  sessionApprovalRule: z.string().optional(),
  result: approvalResponseSchema,
});

export const agentReplayRecordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    time: z.number(),
    message: replayContextMessageSchema,
  }),
  z.object({
    type: z.literal('compaction'),
    time: z.number(),
    result: z.union([compactionResultSchema, z.literal('cancelled')]).optional(),
    instruction: z.string().optional(),
  }),
  z.object({
    type: z.literal('goal_updated'),
    time: z.number(),
    snapshot: goalSnapshotSchema,
    change: z.union([goalChangeSchema, z.object({ kind: z.literal('created') })]),
  }),
  z.object({
    type: z.literal('plan_updated'),
    time: z.number(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('config_updated'),
    time: z.number(),
    config: agentConfigUpdateDataSchema,
  }),
  z.object({
    type: z.literal('permission_updated'),
    time: z.number(),
    mode: permissionModeSchema,
  }),
  z.object({
    type: z.literal('approval_result'),
    time: z.number(),
    record: permissionApprovalResultRecordSchema,
  }),
]);

const permissionDataSchema = z.object({
  mode: permissionModeSchema,
  rules: z.array(
    z.object({
      decision: z.enum(['allow', 'deny', 'ask']),
      scope: z.enum(['turn-override', 'session-runtime', 'project', 'user']),
      pattern: z.string(),
      reason: z.string().optional(),
    }),
  ),
});

const toolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(['builtin', 'user', 'mcp']),
  disclosure: z.enum(['inline', 'deferred']).optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});

export const resumedAgentStateSchema = z.object({
  type: z.enum(['main', 'sub']),
  config: agentConfigDataSchema,
  context: replayAgentContextDataSchema,
  replay: z.array(agentReplayRecordSchema),
  permission: permissionDataSchema,
  plan: planDataSchema,
  swarmMode: z.boolean().optional(),
  usage: usageStatusSchema,
  tools: z.array(toolInfoSchema),
  tasks: z.array(agentTaskInfoSchema),
});

export const agentReplayViewContract = {
  read: { input: z.tuple([]), output: resumedAgentStateSchema },
} satisfies ServiceContract;

export const agentShellCommandContract = {
  run: {
    input: z.tuple([runShellCommandPayloadSchema]),
    output: shellCommandResultSchema,
  },
  cancel: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

export const agentProfileContract = {
  bind: { input: z.tuple([bindAgentInputSchema]), output: noResult },
  data: { input: z.tuple([]), output: profileDataSchema },
  getModel: { input: z.tuple([]), output: z.string() },
  setModel: { input: z.tuple([z.string()]), output: setModelResultSchema },
  setThinking: { input: z.tuple([thinkingLevelSchema]), output: noResult },
} satisfies ServiceContract;

export const agentUsageContract = {
  status: { input: z.tuple([]), output: usageStatusSchema },
} satisfies ServiceContract;

export const agentPlanContract = {
  status: { input: z.tuple([]), output: planDataSchema },
  enter: { input: z.tuple([]), output: noResult },
  clear: { input: z.tuple([]), output: noResult },
  cancel: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;

export const agentTaskContract = {
  list: {
    input: z.tuple([z.boolean().optional(), z.number().optional()]),
    output: z.array(agentTaskInfoSchema),
  },
  detach: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
  stopByUser: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
  stop: {
    input: z.tuple([z.string(), z.string().optional()]),
    output: maybe(agentTaskInfoSchema),
  },
  readOutput: {
    input: z.tuple([z.string(), z.number().optional()]),
    output: z.string(),
  },
} satisfies ServiceContract;
