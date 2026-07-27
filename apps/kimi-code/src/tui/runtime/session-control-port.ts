/**
 * Runtime-neutral control plane for the interactive TUI.
 *
 * Session discovery and creation stay under `sessions`; one-session lifecycle
 * stays under `session(sessionId)`; turn-driving and agent-owned state stay
 * under `agent(sessionId, agentId)`. Event streams and reverse-RPC callbacks
 * deliberately live outside this command port.
 */

export const MAIN_AGENT_ID = 'main';

export interface SessionIdentity {
  readonly id: string;
  readonly workDir?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionListInput {
  readonly workDir?: string;
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
}

export interface SessionCreateInput {
  readonly workDir: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: AgentPermissionMode;
  readonly planMode?: boolean;
  readonly additionalDirs?: readonly string[];
}

export interface SessionResumeInput {
  readonly id: string;
  readonly additionalDirs?: readonly string[];
  readonly replayTurnLimit?: number;
}

export interface SessionCollectionPort {
  list(input?: SessionListInput): Promise<readonly SessionIdentity[]>;
  create(input: SessionCreateInput): Promise<SessionIdentity>;
  /** Restore a persisted session, or return undefined when it no longer exists. */
  resume(input: SessionResumeInput): Promise<SessionIdentity | undefined>;
}

export interface SessionForkInput {
  readonly title?: string;
}

export interface SessionLifecyclePort {
  getIdentity(): Promise<SessionIdentity>;
  close(): Promise<void>;
  setTitle(title: string): Promise<void>;
  fork(input?: SessionForkInput): Promise<SessionIdentity>;
}

export interface AgentTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface AgentImagePart {
  readonly type: 'image_url';
  readonly imageUrl: {
    readonly url: string;
    readonly id?: string;
  };
}

export interface AgentVideoPart {
  readonly type: 'video_url';
  readonly videoUrl: {
    readonly url: string;
    readonly id?: string;
  };
}

export type AgentPromptPart = AgentTextPart | AgentImagePart | AgentVideoPart;
export type AgentPromptInput = string | readonly AgentPromptPart[];

export interface AgentShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}

export type AgentPermissionMode = 'manual' | 'yolo' | 'auto';

export interface AgentTokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface AgentUsageStatus {
  readonly byModel?: Readonly<Record<string, AgentTokenUsage>>;
  readonly currentTurn?: AgentTokenUsage;
  readonly total?: AgentTokenUsage;
}

export interface AgentRuntimeStatus {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: AgentPermissionMode;
  readonly planMode: boolean;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: AgentUsageStatus;
}

export interface AgentPlan {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export type AgentGoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export interface AgentGoalBudget {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

export interface AgentGoal {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: AgentGoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: AgentGoalBudget;
  readonly terminalReason?: string;
}

export interface AgentGoalCreateInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}

export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface AgentTask {
  readonly taskId: string;
  readonly kind: 'process' | 'agent' | 'question';
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly timeoutMs?: number;
  readonly command?: string;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly questionCount?: number;
  readonly toolCallId?: string;
}

export interface AgentTaskListInput {
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export interface SessionAgentControlPort {
  prompt(input: AgentPromptInput): Promise<void>;
  steer(input: AgentPromptInput): Promise<void>;
  cancel(): Promise<void>;

  runShellCommand(command: string, commandId?: string): Promise<AgentShellResult>;
  cancelShellCommand(commandId: string): Promise<void>;

  getStatus(): Promise<AgentRuntimeStatus>;
  getModel(): Promise<string | undefined>;
  setModel(model: string): Promise<void>;
  getThinking(): Promise<string>;
  setThinking(effort: string): Promise<void>;
  setPermission(mode: AgentPermissionMode): Promise<void>;

  getPlan(): Promise<AgentPlan | null>;
  setPlanMode(enabled: boolean): Promise<void>;
  clearPlan(): Promise<void>;

  getGoal(): Promise<AgentGoal | null>;
  createGoal(input: AgentGoalCreateInput): Promise<AgentGoal>;
  pauseGoal(): Promise<AgentGoal>;
  resumeGoal(): Promise<AgentGoal>;
  cancelGoal(): Promise<AgentGoal>;

  listTasks(input?: AgentTaskListInput): Promise<readonly AgentTask[]>;
  detachTask(taskId: string): Promise<AgentTask | undefined>;
  getTaskOutput(taskId: string, tail?: number): Promise<string>;
  stopTask(taskId: string, reason?: string): Promise<void>;
}

export interface SessionControlPort {
  readonly sessions: SessionCollectionPort;
  session(sessionId: string): SessionLifecyclePort;
  agent(sessionId: string, agentId?: string): SessionAgentControlPort;
}
