import type {
  AgentGoal,
  AgentPermissionMode,
  AgentTask,
  AgentTaskStatus,
  AgentTokenUsage,
  AgentUsageStatus,
} from './session-control-port';
import type {
  TUIContextMessage,
} from './session-context-view-port';

export const TUI_AGENT_EVENT_TYPES = [
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.retrying',
  'turn.step.interrupted',
  'turn.step.completed',
  'assistant.delta',
  'hook.result',
  'thinking.delta',
  'tool.call.delta',
  'tool.call.started',
  'tool.progress',
  'shell.output',
  'shell.started',
  'tool.result',
  'prompt.completed',
  'prompt.aborted',
  'goal.updated',
  'skill.activated',
  'plugin_command.activated',
  'error',
  'warning',
  'notice',
  'agent.status.updated',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'subagent.spawned',
  'subagent.started',
  'subagent.suspended',
  'subagent.completed',
  'subagent.failed',
  // The Klient adapter translates v2 `task.*` names to this legacy TUI contract.
  'background.task.started',
  'background.task.terminated',
  'cron.fired',
  'mcp.server.status',
  'tool.list.updated',
] as const;

export type TUIAgentEventType = (typeof TUI_AGENT_EVENT_TYPES)[number];

export type TUIReplayPromptOrigin =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'skill_activation';
      readonly activationId: string;
      readonly skillName: string;
      readonly skillArgs?: string;
      readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
      readonly skillType?: string;
      readonly skillPath?: string;
      readonly skillSource?: 'project' | 'user' | 'extra' | 'builtin';
    }
  | {
      readonly kind: 'plugin_command';
      readonly activationId: string;
      readonly pluginId: string;
      readonly commandName: string;
      readonly commandArgs?: string;
      readonly trigger: 'user-slash';
    }
  | {
      readonly kind: 'injection';
      readonly variant: string;
      readonly ownerPromptId?: string;
    }
  | {
      readonly kind: 'shell_command';
      readonly phase: 'input' | 'output';
      readonly isError?: boolean;
    }
  | { readonly kind: 'compaction_summary' }
  | { readonly kind: 'system_trigger'; readonly name: string }
  | {
      readonly kind: 'background_task' | 'task';
      readonly taskId: string;
      readonly status: AgentTaskStatus;
      readonly notificationId: string;
    }
  | {
      readonly kind: 'cron_job';
      readonly jobId: string;
      readonly cron: string;
      readonly recurring: boolean;
      readonly coalescedCount: number;
      readonly stale: boolean;
    }
  | { readonly kind: 'cron_missed'; readonly count: number }
  | {
      readonly kind: 'hook_result';
      readonly event: string;
      readonly blocked?: boolean;
    }
  | { readonly kind: 'retry'; readonly trigger?: string }
  | {
      readonly kind: 'team_message';
      readonly teamId: string;
      readonly fromAgentId: string;
      readonly toAgentId: string;
      readonly messageType: 'message' | 'shutdown_request' | 'shutdown_response';
    };

export interface TUIReplayContextMessage
  extends Omit<TUIContextMessage, 'origin'> {
  readonly origin?: TUIReplayPromptOrigin;
}

export interface TUIReplayModelCapabilities {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools?: boolean;
}

export interface TUIReplayAgentConfig {
  readonly cwd: string;
  readonly modelAlias?: string;
  readonly providerModel?: string;
  readonly modelCapabilities: TUIReplayModelCapabilities;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
}

export interface TUIReplayAgentConfigUpdate {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
}

export interface TUIReplayPermissionRule {
  readonly decision: 'allow' | 'deny' | 'ask';
  readonly scope: 'turn-override' | 'session-runtime' | 'project' | 'user';
  readonly pattern: string;
  readonly reason?: string;
}

export interface TUIReplayPermission {
  readonly mode: AgentPermissionMode;
  readonly rules: readonly TUIReplayPermissionRule[];
}

export interface TUIReplayPlan {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export interface TUIReplayCompactionResult {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
}

export type TUIReplayGoalChange =
  | { readonly kind: 'created' }
  | {
      readonly kind: 'lifecycle' | 'completion';
      readonly status?: AgentGoal['status'];
      readonly reason?: string;
      readonly stats?: {
        readonly turnsUsed: number;
        readonly tokensUsed: number;
        readonly wallClockMs: number;
      };
      readonly actor?: 'user' | 'model' | 'runtime' | 'system';
    };

export interface TUIReplayApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface TUIReplayApprovalRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: TUIReplayApprovalResponse;
}

export type TUIAgentReplayRecord =
  | {
      readonly type: 'message';
      readonly time: number;
      readonly message: TUIReplayContextMessage;
    }
  | {
      readonly type: 'compaction';
      readonly time: number;
      readonly result?: TUIReplayCompactionResult | 'cancelled';
      readonly instruction?: string;
    }
  | {
      readonly type: 'goal_updated';
      readonly time: number;
      readonly snapshot: AgentGoal;
      readonly change: TUIReplayGoalChange;
    }
  | {
      readonly type: 'plan_updated';
      readonly time: number;
      readonly enabled: boolean;
    }
  | {
      readonly type: 'config_updated';
      readonly time: number;
      readonly config: TUIReplayAgentConfigUpdate;
    }
  | {
      readonly type: 'permission_updated';
      readonly time: number;
      readonly mode: AgentPermissionMode;
    }
  | {
      readonly type: 'approval_result';
      readonly time: number;
      readonly record: TUIReplayApprovalRecord;
    };

export interface TUIReplayToolInfo {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly source: 'builtin' | 'user' | 'mcp';
  readonly disclosure?: 'inline' | 'deferred';
  readonly info?: Readonly<Record<string, unknown>>;
}

export interface TUIAgentReplay {
  readonly type: 'main' | 'sub' | 'independent';
  readonly config: TUIReplayAgentConfig;
  readonly context: {
    readonly history: readonly TUIReplayContextMessage[];
    readonly tokenCount: number;
  };
  readonly replay: readonly TUIAgentReplayRecord[];
  readonly permission: TUIReplayPermission;
  readonly plan: TUIReplayPlan | null;
  readonly swarmMode?: boolean;
  readonly usage: AgentUsageStatus;
  readonly tools: readonly TUIReplayToolInfo[];
  readonly tasks: readonly AgentTask[];
  /** Legacy-only persisted tool state; v2 intentionally leaves it absent. */
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly warning?: string;
}

export type TUIToolInputDisplay =
  | {
      readonly kind: 'command';
      readonly command: string;
      readonly cwd?: string;
      readonly description?: string;
      readonly language?: 'bash';
    }
  | {
      readonly kind: 'file_io';
      readonly operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      readonly path: string;
      readonly detail?: string;
      readonly content?: string;
      readonly before?: string;
      readonly after?: string;
    }
  | {
      readonly kind: 'diff';
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly hunks?: number;
    }
  | {
      readonly kind: 'search';
      readonly query: string;
      readonly scope?: string;
    }
  | {
      readonly kind: 'url_fetch';
      readonly url: string;
      readonly method?: string;
    }
  | {
      readonly kind: 'agent_call';
      readonly agent_name: string;
      readonly prompt: string;
      readonly background?: boolean;
    }
  | {
      readonly kind: 'skill_call';
      readonly skill_name: string;
      readonly args?: string;
    }
  | {
      readonly kind: 'todo_list';
      readonly items: readonly {
        readonly title: string;
        readonly status: string;
      }[];
    }
  | {
      readonly kind: 'task';
      readonly task_id: string;
      readonly status: string;
      readonly description: string;
      readonly task_kind?: string;
    }
  | {
      readonly kind: 'task_stop';
      readonly task_id: string;
      readonly task_description: string;
    }
  | {
      readonly kind: 'plan_review';
      readonly plan: string;
      readonly path?: string;
      readonly options?: readonly {
        readonly label: string;
        readonly description: string;
      }[];
    }
  | {
      readonly kind: 'goal_start';
      readonly objective: string;
      readonly completionCriterion?: string;
      readonly mode: 'manual' | 'yolo';
    }
  | {
      readonly kind: 'generic';
      readonly summary: string;
      readonly detail?: unknown;
    };

export interface TUIToolUpdate {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface TUIAgentErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: TUIAgentErrorPayload;
}

export type TUIAgentGoalChange = Exclude<TUIReplayGoalChange, { readonly kind: 'created' }>;

type TUIAgentEventPayload =
  | {
      readonly type: 'turn.started';
      readonly turnId: number;
      readonly origin: TUIReplayPromptOrigin;
      readonly prompt?: string;
    }
  | {
      readonly type: 'turn.ended';
      readonly turnId: number;
      readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
      readonly error?: TUIAgentErrorPayload;
      readonly durationMs?: number;
    }
  | {
      readonly type: 'turn.step.started';
      readonly turnId: number;
      readonly step: number;
      readonly stepId?: string;
    }
  | {
      readonly type: 'turn.step.retrying';
      readonly turnId: number;
      readonly step: number;
      readonly stepId?: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName: string;
      readonly errorMessage: string;
      readonly statusCode?: number;
    }
  | {
      readonly type: 'turn.step.interrupted';
      readonly turnId: number;
      readonly step: number;
      readonly stepId?: string;
      readonly reason: string;
      readonly message?: string;
    }
  | {
      readonly type: 'turn.step.completed';
      readonly turnId: number;
      readonly step: number;
      readonly stepId?: string;
      readonly usage?: AgentTokenUsage;
      readonly finishReason?: string;
      readonly llmFirstTokenLatencyMs?: number;
      readonly llmStreamDurationMs?: number;
      readonly llmRequestBuildMs?: number;
      readonly llmServerFirstTokenMs?: number;
      readonly llmServerDecodeMs?: number;
      readonly llmClientConsumeMs?: number;
      readonly providerFinishReason?:
        | 'completed'
        | 'tool_calls'
        | 'truncated'
        | 'filtered'
        | 'paused'
        | 'other';
      readonly rawFinishReason?: string;
    }
  | {
      readonly type: 'assistant.delta';
      readonly turnId: number;
      readonly delta: string;
    }
  | {
      readonly type: 'hook.result';
      readonly turnId?: number;
      readonly hookEvent: string;
      readonly content: string;
      readonly blocked?: boolean;
    }
  | {
      readonly type: 'thinking.delta';
      readonly turnId: number;
      readonly delta: string;
    }
  | {
      readonly type: 'tool.call.delta';
      readonly turnId: number;
      readonly toolCallId: string;
      readonly name?: string;
      readonly argumentsPart?: string;
    }
  | {
      readonly type: 'tool.call.started';
      readonly turnId: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
      readonly description?: string;
      readonly display?: TUIToolInputDisplay;
    }
  | {
      readonly type: 'tool.progress';
      readonly turnId: number;
      readonly toolCallId: string;
      readonly update: TUIToolUpdate;
    }
  | {
      readonly type: 'shell.output';
      readonly commandId: string;
      readonly update: TUIToolUpdate;
      readonly taskId?: string;
    }
  | {
      readonly type: 'shell.started';
      readonly commandId: string;
      readonly taskId: string;
    }
  | {
      readonly type: 'tool.result';
      readonly turnId: number;
      readonly toolCallId: string;
      readonly output: unknown;
      readonly isError?: boolean;
      readonly synthetic?: boolean;
    }
  | {
      readonly type: 'prompt.completed';
      readonly promptId: string;
      readonly finishedAt: string;
      readonly reason?: 'completed' | 'failed' | 'blocked';
    }
  | {
      readonly type: 'prompt.aborted';
      readonly promptId: string;
      readonly abortedAt: string;
    }
  | {
      readonly type: 'goal.updated';
      readonly snapshot: AgentGoal | null;
      readonly change?: TUIAgentGoalChange;
    }
  | {
      readonly type: 'skill.activated';
      readonly activationId: string;
      readonly skillName: string;
      readonly skillArgs?: string;
      readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
      readonly skillPath?: string;
      readonly skillSource?: 'project' | 'user' | 'extra' | 'builtin';
    }
  | {
      readonly type: 'plugin_command.activated';
      readonly activationId: string;
      readonly pluginId: string;
      readonly commandName: string;
      readonly commandArgs?: string;
      readonly trigger: 'user-slash';
    }
  | ({ readonly type: 'error' } & TUIAgentErrorPayload)
  | {
      readonly type: 'warning';
      readonly message: string;
      readonly code?: string;
    }
  | {
      readonly type: 'notice';
      readonly message: string;
      readonly code?: string;
    }
  | {
      readonly type: 'agent.status.updated';
      readonly model?: string;
      readonly thinkingEffort?: string;
      readonly contextTokens?: number;
      readonly maxContextTokens?: number;
      readonly contextUsage?: number;
      readonly planMode?: boolean;
      readonly swarmMode?: boolean;
      readonly permission?: AgentPermissionMode;
      readonly usage?: AgentUsageStatus;
      readonly phase?: unknown;
    }
  | {
      readonly type: 'compaction.started';
      readonly trigger: 'manual' | 'auto';
      readonly instruction?: string;
    }
  | {
      readonly type: 'compaction.blocked';
      readonly turnId?: number;
    }
  | {
      readonly type: 'compaction.cancelled';
    }
  | {
      readonly type: 'compaction.completed';
      readonly result: TUIReplayCompactionResult;
    }
  | {
      readonly type: 'subagent.spawned';
      readonly subagentId: string;
      readonly subagentName: string;
      readonly parentToolCallId: string;
      readonly parentToolCallUuid?: string;
      readonly parentAgentId?: string;
      readonly callerAgentId?: string;
      readonly description?: string;
      readonly swarmIndex?: number;
      readonly runInBackground: boolean;
    }
  | {
      readonly type: 'subagent.started';
      readonly subagentId: string;
    }
  | {
      readonly type: 'subagent.suspended';
      readonly subagentId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'subagent.completed';
      readonly subagentId: string;
      readonly resultSummary: string;
      readonly usage?: AgentTokenUsage;
      readonly contextTokens?: number;
    }
  | {
      readonly type: 'subagent.failed';
      readonly subagentId: string;
      readonly error: string;
    }
  | {
      readonly type: 'background.task.started';
      readonly info: AgentTask;
    }
  | {
      readonly type: 'background.task.terminated';
      readonly info: AgentTask;
    }
  | {
      readonly type: 'cron.fired';
      readonly origin: Extract<TUIReplayPromptOrigin, { readonly kind: 'cron_job' }>;
      readonly prompt: string;
    }
  | {
      readonly type: 'mcp.server.status';
      readonly server: {
        readonly name: string;
        readonly transport: 'stdio' | 'http' | 'sse';
        readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
        readonly toolCount: number;
        readonly error?: string;
      };
    }
  | {
      readonly type: 'tool.list.updated';
      readonly reason: 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';
      readonly serverName: string;
    };

export type TUIAgentEvent = TUIAgentEventPayload & {
  readonly sessionId: string;
  readonly agentId: string;
};

export type TUIAgentEventListener = (event: TUIAgentEvent) => void;
export type UnsubscribeAgentEvents = () => void;

/**
 * Runtime-neutral event chain rooted at one interactive agent. Live delivery
 * may include descendant agents; replay is always read for the root agent.
 */
export interface AgentEventsPort {
  readonly sessionId: string;
  readonly agentId: string;
  subscribe(listener: TUIAgentEventListener): UnsubscribeAgentEvents;
  readReplay(): Promise<TUIAgentReplay | undefined>;
}
