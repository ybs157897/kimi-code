/**
 * Product wire DTOs — a faithful, sidecar-local mirror of the kimi-web wire
 * spec (`apps/kimi-web/src/api/daemon/wire.ts`). The desktop sidecar cannot
 * import from the web app (separate TypeScript project, and the two sides meet
 * only over the wire), so the shapes the product layer RETURNS and EMITS are
 * re-declared here field-for-field. Keep this in lockstep with `wire.ts`; do
 * not invent alternative field names. Only the first-vertical-slice subset is
 * mirrored (chat-loop methods + streaming events).
 *
 * ALL fields stay snake_case exactly as they appear on the kimi-web wire.
 */

// ---------------------------------------------------------------------------
// Envelope & Page
// ---------------------------------------------------------------------------

export interface WireEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
}

export interface WirePage<T> {
  items: T[];
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface WireSessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
}

export interface WireSessionUsageDelta {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

export interface WirePermissionRule {
  id: string;
  tool_name: string;
  matcher?: {
    kind: 'command_prefix' | 'path_glob' | 'exact_input' | 'always';
    value?: string;
  };
  decision: 'approved';
  created_at: string;
  created_by: 'user' | 'agent';
}

export interface WireSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  archived: boolean;
  current_prompt_id?: string;
  last_prompt?: string;
  workspace_id?: string;
  metadata: {
    cwd: string;
    [key: string]: unknown;
  };
  agent_config: {
    model: string;
    system_prompt?: string;
    tools?: string[];
    mcp_servers?: string[];
    thinking?: string;
    permission_mode?: string;
    plan_mode?: boolean;
    swarm_mode?: boolean;
    goal_objective?: string;
    goal_control?: 'pause' | 'resume' | 'cancel';
  };
  usage: WireSessionUsage;
  permission_rules: WirePermissionRule[];
  message_count: number;
  last_seq: number;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type WireMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: WireImageSource }
  | { type: 'video'; source: WireImageSource }
  | { type: 'file'; file_id: string; name: string; media_type: string; size: number }
  | { type: 'thinking'; thinking: string; signature?: string };

export type WireImageSource =
  | { kind: 'url'; url: string; id?: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string };

export interface WireMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: WireMessageContent[];
  created_at: string;
  prompt_id?: string;
  parent_message_id?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface WirePromptSubmission {
  content: WireMessageContent[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  model?: string;
  thinking?: string;
  permission_mode?: string;
  plan_mode?: boolean;
  swarm_mode?: boolean;
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel';
}

export interface WirePromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  /** 'running' = started immediately; 'queued' = parked behind the active prompt. */
  status?: 'running' | 'queued';
}

export interface WireSessionAbortResult {
  aborted: boolean;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface WireApprovalRequest {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display?: unknown;
  display?: unknown;
  expires_at: string;
  created_at: string;
}

export interface WireApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selected_label?: string;
}

export interface WireApprovalResolveResult {
  resolved: boolean;
  resolved_at?: string;
}

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

export interface WireQuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  is_recommended?: boolean;
}

export interface WireQuestionItem {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: WireQuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
  other_description?: string;
}

export interface WireQuestionRequest {
  question_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: WireQuestionItem[];
  created_at: string;
}

export type WireQuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' };

export interface WireQuestionResponse {
  answers: Record<string, WireQuestionAnswer>;
  method?: 'enter' | 'space' | 'number_key' | 'click';
  note?: string;
}

export interface WireQuestionResolveResult {
  resolved: boolean;
  resolved_at?: string;
}

// ---------------------------------------------------------------------------
// Boot / read-only methods (slice 2). Shapes mirror the kimi-web wire spec
// (`wire.ts`) and the kap-server routes named in desktop-product.md §12.3.
// ---------------------------------------------------------------------------

// --- Workspace + folder picker (routes/workspaces.ts, routes/workspaceFs.ts) ---

export interface WireWorkspace {
  id: string;
  root: string;
  name: string;
  created_at?: string;
  last_opened_at?: string;
  session_count: number;
}

export interface WireFsHomeResult {
  home: string;
  recent_roots: string[];
}

// --- Model catalog (routes/modelCatalog.ts) ---

export interface WireModel {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

// --- Auth readiness (routes/auth.ts) ---

export interface WireManagedProvider {
  status: string;
  [key: string]: unknown;
}

export interface WireAuthResult {
  ready: boolean;
  providers_count: number;
  default_model: string | null;
  managed_provider: WireManagedProvider | null;
}

export type WireOAuthLoginStartResult =
  | {
      flow_id: string;
      provider: string;
      status: 'pending';
      verification_uri: string;
      verification_uri_complete: string;
      user_code: string;
      expires_in: number;
      interval: number;
      expires_at: string;
    }
  | {
      flow_id: string;
      provider: string;
      status: 'authenticated';
    };

export interface WireOAuthLoginPollResult {
  flow_id: string;
  status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
  resolved_at?: string;
}

export interface WireOAuthCancelResult {
  cancelled: boolean;
  status: string;
}

export interface WireLogoutResult {
  logged_out: boolean;
}

export interface WireProviderRefreshResult {
  changed: Array<{
    provider_id: string;
    provider_name: string;
    added: number;
    removed: number;
  }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

// --- Server metadata (routes/meta.ts) ---

export interface WireMetaCapabilities {
  websocket: boolean;
  file_upload: boolean;
  fs_query: boolean;
  mcp: boolean;
  tasks: boolean;
  terminal: boolean;
}

export interface WireMeta {
  server_version: string;
  capabilities: WireMetaCapabilities;
  server_id: string;
  started_at: string;
  open_in_apps: string[];
  dangerous_bypass_auth: boolean;
  backend: 'v2';
}

// --- Config (routes/config.ts) ---

export interface WireConfigProvider {
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
}

export interface WireConfig {
  providers: Record<string, WireConfigProvider>;
  default_provider?: string;
  default_model?: string;
  models?: Record<string, unknown>;
  thinking?: unknown;
  plan_mode?: boolean;
  yolo?: boolean;
  default_permission_mode?: string;
  default_plan_mode?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  merge_all_available_skills?: boolean;
  extra_skill_dirs?: string[];
  loop_control?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  raw?: Record<string, unknown>;
}

// --- Session snapshot (routes/snapshot.ts) ---

export interface WireInFlightToolCall {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  last_progress?: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

export interface WireInFlightTurn {
  turn_id: number;
  assistant_text: string;
  thinking_text: string;
  running_tools: WireInFlightToolCall[];
  current_prompt_id?: string;
}

export type WireTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WireTask {
  id: string;
  session_id: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: WireTaskStatus;
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
  subagent_phase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  subagent_type?: string;
  parent_tool_call_id?: string;
  suspended_reason?: string;
  swarm_index?: number;
  run_in_background?: boolean;
}

export interface WireSessionSnapshot {
  as_of_seq: number;
  epoch: string;
  session: WireSession;
  messages: { items: WireMessage[]; has_more: boolean };
  in_flight_turn: WireInFlightTurn | null;
  subagents?: WireTask[];
  pending_approvals: WireApprovalRequest[];
  pending_questions: WireQuestionRequest[];
}

// ---------------------------------------------------------------------------
// Slice A — session-level read methods (status / goal / warnings / skills /
// tasks / git status). Shapes mirror the kap-server routes named in
// desktop-product.md §12.3 and the kimi-web daemon client wire types.
// ---------------------------------------------------------------------------

// GET /sessions/{id}/status — live runtime state.
export interface WireSessionStatus {
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}

// GET /sessions/{id}/goal — camelCase on the wire (matches the daemon wire).
export interface WireGoalBudgetReport {
  tokenBudget: number | null;
  turnBudget: number | null;
  wallClockBudgetMs: number | null;
  remainingTokens: number | null;
  remainingTurns: number | null;
  remainingWallClockMs: number | null;
  tokenBudgetReached: boolean;
  turnBudgetReached: boolean;
  wallClockBudgetReached: boolean;
  overBudget: boolean;
}

export interface WireGoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  terminalReason?: string;
  budget: WireGoalBudgetReport;
}

// GET /sessions/{id}/warnings
export interface WireSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

// GET /sessions/{id}/skills
export interface WireSkillDescriptor {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

// GET /sessions/{id}/tasks
export type WireTaskKind = 'subagent' | 'bash' | 'tool';

export interface WireTaskListItem {
  id: string;
  session_id: string;
  kind: WireTaskKind;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
}

// POST /sessions/{id}/fs:git_status — note `pullRequest` is camelCase on wire.
export interface WireGitPullRequest {
  number: number;
  state: 'open' | 'merged' | 'closed' | 'draft';
  url: string;
}

export interface WireGitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest: WireGitPullRequest | null;
}

// ---------------------------------------------------------------------------
// WS Events (S→C) — the chat-loop subset the product projector emits.
// Mirrors the `WireEventBase` family in wire.ts: `{ type, seq, session_id,
// timestamp, payload }`. S3 feeds these through kimi-web's `toAppEvent`.
// ---------------------------------------------------------------------------

interface WireEventBase<T extends string, P> {
  type: T;
  seq: number;
  session_id: string;
  timestamp: string;
  payload: P;
}

type WireEventSessionWorkChanged = WireEventBase<
  'event.session.work_changed',
  {
    busy: boolean;
    main_turn_active?: boolean;
    pending_interaction?: 'none' | 'approval' | 'question';
    last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  }
>;

type WireEventSessionUsageUpdated = WireEventBase<
  'event.session.usage_updated',
  {
    usage: WireSessionUsage;
    delta: WireSessionUsageDelta;
  }
>;

type WireEventMessageCreated = WireEventBase<
  'event.message.created',
  { message: WireMessage }
>;

type WireEventMessageUpdated = WireEventBase<
  'event.message.updated',
  {
    message_id: string;
    content: WireMessageContent[];
    status: 'pending' | 'completed' | 'error';
  }
>;

type WireEventAssistantDelta = WireEventBase<
  'event.assistant.delta',
  {
    message_id: string;
    content_index: number;
    delta: { text?: string; thinking?: string };
  }
>;

type WireEventToolOutput = WireEventBase<
  'event.tool.output',
  {
    tool_call_id: string;
    chunk: string;
    stream: 'stdout' | 'stderr';
  }
>;

type WireEventApprovalRequested = WireEventBase<
  'event.approval.requested',
  WireApprovalRequest
>;

type WireEventApprovalResolved = WireEventBase<
  'event.approval.resolved',
  {
    approval_id: string;
    decision: 'approved' | 'rejected' | 'cancelled';
    scope?: 'session';
    feedback?: string;
    selected_label?: string;
    resolved_by: string;
    resolved_at: string;
  }
>;

type WireEventQuestionRequested = WireEventBase<
  'event.question.requested',
  WireQuestionRequest
>;

type WireEventQuestionAnswered = WireEventBase<
  'event.question.answered',
  {
    question_id: string;
    answers: Record<string, WireQuestionAnswer>;
    method?: string;
    note?: string;
    resolved_by: string;
    resolved_at: string;
  }
>;

/**
 * Catch-all for notices/warnings/errors the projector surfaces without a
 * dedicated product event type. Mirrors wire.ts's `WireEventUnknown` so
 * `toAppEvent` folds it to `{ type: 'unknown', raw }` and the reducer renders
 * a structured notice. `payload` carries `{ code?, msg, name? }`.
 */
type WireEventNotice = WireEventBase<
  'event.product.notice',
  {
    severity: 'info' | 'warning' | 'error';
    code?: string;
    msg: string;
    name?: string;
  }
>;

export type WireEvent =
  | WireEventSessionWorkChanged
  | WireEventSessionUsageUpdated
  | WireEventMessageCreated
  | WireEventMessageUpdated
  | WireEventAssistantDelta
  | WireEventToolOutput
  | WireEventApprovalRequested
  | WireEventApprovalResolved
  | WireEventQuestionRequested
  | WireEventQuestionAnswered
  | WireEventNotice;
