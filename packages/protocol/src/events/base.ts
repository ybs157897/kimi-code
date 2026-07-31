import { z } from 'zod';

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
}

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export type TaskLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export type KimiErrorCode =
  | 'config.invalid'
  | 'session.not_found'
  | 'session.already_exists'
  | 'session.id_invalid'
  | 'session.id_required'
  | 'session.id_empty'
  | 'session.title_empty'
  | 'session.state_not_found'
  | 'session.state_invalid'
  | 'session.fork_active_turn'
  | 'session.undo_unavailable'
  | 'session.export_not_found'
  | 'session.export_missing_version'
  | 'session.export_output_conflict'
  | 'session.export_too_large'
  | 'session.closed'
  | 'session.permission_mode_invalid'
  | 'session.thinking_empty'
  | 'session.model_empty'
  | 'session.plan_mode_invalid'
  | 'session.approval_handler_error'
  | 'session.question_handler_error'
  | 'session.init_failed'
  | 'agent.not_found'
  | 'turn.agent_busy'
  | 'goal.already_exists'
  | 'goal.not_found'
  | 'goal.objective_empty'
  | 'goal.objective_too_long'
  | 'goal.status_invalid'
  | 'goal.metadata_reserved'
  | 'goal.not_resumable'
  | 'goal.unsupported_agent'
  | 'model.not_configured'
  | 'model.config_invalid'
  | 'profile.thinking_alias_conflict'
  | 'profile.unknown'
  | 'profile.already_bound'
  | 'profile.not_bound'
  | 'model.not_found'
  | 'auth.login_required'
  | 'auth.provisioning_required'
  | 'auth.token_missing'
  | 'auth.token_unauthorized'
  | 'auth.model_not_resolved'
  | 'context.overflow'
  | 'loop.max_steps_exceeded'
  | 'provider.api_error'
  | 'provider.filtered'
  | 'provider.rate_limit'
  | 'provider.auth_error'
  | 'provider.connection_error'
  | 'provider.overloaded'
  | 'provider.not_found'
  | 'skill.not_found'
  | 'skill.type_unsupported'
  | 'skill.name_empty'
  | 'records.write_failed'
  | 'compaction.failed'
  | 'compaction.unable'
  | 'task.task_id_empty'
  | 'usage.turn_id_conflict'
  | 'mcp.server_not_found'
  | 'mcp.server_disabled'
  | 'mcp.startup_failed'
  | 'mcp.tool_name_collision'
  | 'message.not_found'
  | 'plugin.not_found'
  | 'plugin.load_failed'
  | 'request.invalid'
  | 'request.work_dir_required'
  | 'request.prompt_input_empty'
  | 'prompt.not_found'
  | 'prompt.already_completed'
  | 'session.busy'
  | 'shell.git_bash_not_found'
  | 'workspace.not_found'
  | 'terminal.not_found'
  | 'file.not_found'
  | 'file.too_large'
  | 'fs.path_not_found'
  | 'fs.permission_denied'
  | 'fs.path_escapes'
  | 'fs.is_directory'
  | 'fs.is_binary'
  | 'fs.too_large'
  | 'fs.already_exists'
  | 'fs.too_many_results'
  | 'fs.grep_timeout'
  | 'fs.git_unavailable'
  | 'os.fs.not_found'
  | 'os.fs.is_directory'
  | 'os.fs.not_directory'
  | 'os.fs.already_exists'
  | 'os.fs.permission_denied'
  | 'os.fs.not_empty'
  | 'os.fs.unavailable'
  | 'os.fs.unknown'
  | 'os.process.spawn_failed'
  | 'os.process.kill_failed'
  | 'storage.not_found'
  | 'storage.decode_failed'
  | 'storage.corrupted'
  | 'storage.io_failed'
  | 'storage.locked'
  | 'wire.duplicate_op'
  | 'wire.cycle'
  | 'wire.unknown_record'
  | 'validation.failed'
  | 'not_implemented'
  | 'internal';

export interface KimiErrorPayload {
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly cause?: KimiErrorPayload;
}

export interface CompactionResult {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /**
   * Number of real user messages kept verbatim ahead of the summary in the
   * post-compaction live context. Recorded so the wire-transcript reducer can
   * reproduce the live folded length without re-deriving it from the full
   * transcript (which still holds the untruncated originals of messages the
   * live context may have truncated, so the two would otherwise diverge).
   * Optional for backward compatibility with older wire records.
   */
  readonly keptUserMessageCount?: number;
  /**
   * Of `keptUserMessageCount`, how many messages form the head segment (the
   * oldest user input kept when the pool overflowed the budget). Present iff
   * the selection split into head + tail, in which case the live context also
   * holds one elision-marker message between the segments. Optional for
   * backward compatibility with older wire records.
   */
  readonly keptHeadUserMessageCount?: number;
  /**
   * Oldest messages trimmed from the summarizer input when the compaction
   * request overflowed the model window; not covered by the produced summary.
   * Mirrors agent-core's `CompactionResult.droppedCount`; optional for backward
   * compatibility.
   */
  readonly droppedCount?: number;
}

export interface ToolUpdate {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = 'mcp.oauth.authorization_url';

export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
}

export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

/**
 * Non-blocking informational notice for clients (e.g. extension `ctx.notify`).
 * Must not start a turn or change streaming/work state.
 */
export interface NoticeEvent {
  readonly type: 'notice';
  readonly message: string;
  readonly code?: string;
}

export const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
}) satisfies z.ZodType<TokenUsage>;

export const finishReasonSchema = z.enum([
  'completed',
  'tool_calls',
  'truncated',
  'filtered',
  'paused',
  'other',
]) satisfies z.ZodType<FinishReason>;

export const usageStatusSchema = z.object({
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  currentTurn: tokenUsageSchema.optional(),
  total: tokenUsageSchema.optional(),
}) satisfies z.ZodType<UsageStatus>;

export const permissionModeSchema = z.enum(['manual', 'yolo', 'auto']) satisfies z.ZodType<PermissionMode>;

export const skillSourceSchema = z.enum(['project', 'user', 'extra', 'builtin']) satisfies z.ZodType<SkillSource>;

export const taskLifecycleStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]) satisfies z.ZodType<TaskLifecycleStatus>;

export const kimiErrorCodeSchema = z.enum([
  'config.invalid',
  'session.not_found',
  'session.already_exists',
  'session.id_invalid',
  'session.id_required',
  'session.id_empty',
  'session.title_empty',
  'session.state_not_found',
  'session.state_invalid',
  'session.fork_active_turn',
  'session.undo_unavailable',
  'session.export_not_found',
  'session.export_missing_version',
  'session.export_output_conflict',
  'session.export_too_large',
  'session.closed',
  'session.permission_mode_invalid',
  'session.thinking_empty',
  'session.model_empty',
  'session.plan_mode_invalid',
  'session.approval_handler_error',
  'session.question_handler_error',
  'session.init_failed',
  'agent.not_found',
  'turn.agent_busy',
  'goal.already_exists',
  'goal.not_found',
  'goal.objective_empty',
  'goal.objective_too_long',
  'goal.status_invalid',
  'goal.metadata_reserved',
  'goal.not_resumable',
  'goal.unsupported_agent',
  'model.not_configured',
  'model.config_invalid',
  'profile.thinking_alias_conflict',
  'profile.unknown',
  'profile.already_bound',
  'profile.not_bound',
  'model.not_found',
  'auth.login_required',
  'auth.provisioning_required',
  'auth.token_missing',
  'auth.token_unauthorized',
  'auth.model_not_resolved',
  'context.overflow',
  'loop.max_steps_exceeded',
  'provider.api_error',
  'provider.filtered',
  'provider.rate_limit',
  'provider.auth_error',
  'provider.connection_error',
  'provider.overloaded',
  'provider.not_found',
  'skill.not_found',
  'skill.type_unsupported',
  'skill.name_empty',
  'records.write_failed',
  'compaction.failed',
  'compaction.unable',
  'task.task_id_empty',
  'usage.turn_id_conflict',
  'mcp.server_not_found',
  'mcp.server_disabled',
  'mcp.startup_failed',
  'mcp.tool_name_collision',
  'message.not_found',
  'plugin.not_found',
  'plugin.load_failed',
  'request.invalid',
  'request.work_dir_required',
  'request.prompt_input_empty',
  'prompt.not_found',
  'prompt.already_completed',
  'session.busy',
  'shell.git_bash_not_found',
  'workspace.not_found',
  'terminal.not_found',
  'file.not_found',
  'file.too_large',
  'fs.path_not_found',
  'fs.permission_denied',
  'fs.path_escapes',
  'fs.is_directory',
  'fs.is_binary',
  'fs.too_large',
  'fs.already_exists',
  'fs.too_many_results',
  'fs.grep_timeout',
  'fs.git_unavailable',
  'validation.failed',
  'not_implemented',
  'internal',
]) satisfies z.ZodType<KimiErrorCode>;

export const kimiErrorPayloadSchema: z.ZodType<KimiErrorPayload> = z.lazy(
  () => kimiErrorPayloadObjectSchema,
);

const kimiErrorPayloadObjectSchema = z.object({
  code: kimiErrorCodeSchema,
  message: z.string(),
  name: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
  cause: kimiErrorPayloadSchema.optional(),
}) satisfies z.ZodType<KimiErrorPayload>;

export const compactionResultSchema = z.object({
  summary: z.string(),
  compactedCount: z.number(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  keptUserMessageCount: z.number().optional(),
  keptHeadUserMessageCount: z.number().optional(),
  droppedCount: z.number().optional(),
}) satisfies z.ZodType<CompactionResult>;

export const toolUpdateSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  customKind: z.string().optional(),
  customData: z.unknown().optional(),
}) satisfies z.ZodType<ToolUpdate>;

export const mcpOAuthAuthorizationUrlUpdateDataSchema = z.object({
  serverName: z.string(),
  authorizationUrl: z.string(),
}) satisfies z.ZodType<McpOAuthAuthorizationUrlUpdateData>;

export const turnEndReasonSchema = z.enum(['completed', 'cancelled', 'failed', 'blocked']) satisfies z.ZodType<TurnEndReason>;

export const errorEventSchema = kimiErrorPayloadObjectSchema.extend({
  type: z.literal('error'),
}) satisfies z.ZodType<ErrorEvent>;

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  message: z.string(),
  code: z.string().optional(),
}) satisfies z.ZodType<WarningEvent>;

export const noticeEventSchema = z.object({
  type: z.literal('notice'),
  message: z.string(),
  code: z.string().optional(),
}) satisfies z.ZodType<NoticeEvent>;
