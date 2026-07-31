// apps/kimi-web/src/api/daemon/wireSession.ts
// Daemon wire DTOs — session shapes. Part of the shared wire barrel (wire.ts);
// ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type WireSessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted';

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
  /** Text of the most recent user prompt, for search/preview. */
  last_prompt?: string;
  // PRESUMED — daemon adds this once it ships the workspace registry; until then
  // it is absent and the client maps sessions by metadata.cwd === workspace.root.
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
    // Runtime controls — optional on read (the daemon may not backfill them;
    // live values come from GET /sessions/{id}/status).
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

// GET /sessions/{id}/status — live runtime state, aligned with TUI /status.
export interface WireSessionRuntimeStatus {
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}

// GET /sessions/{id}/goal — camelCase, same shape as the `goal.updated` event
// payload. The endpoint returns null when no goal is active.
export interface WireGoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  terminalReason?: string;
  budget: {
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
  };
}

// GET /sessions/{id}/warnings — session-level warnings (e.g. oversized AGENTS.md).
export interface WireSessionWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface WireSessionWarningsResponse {
  warnings: WireSessionWarning[];
}
