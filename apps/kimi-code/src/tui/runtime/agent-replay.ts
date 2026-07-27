import type {
  TUIAgentReplay,
  TUIAgentReplayRecord,
  TUIReplayAgentConfig,
  TUIReplayAgentConfigUpdate,
  TUIReplayApprovalRecord,
  TUIReplayCompactionResult,
  TUIReplayContextMessage,
  TUIReplayGoalChange,
  TUIReplayPermission,
  TUIReplayPlan,
  TUIReplayToolInfo,
} from './agent-events-port';
import type {
  AgentGoal,
  AgentTask,
  AgentUsageStatus,
} from './session-control-port';
import { copyTUIContextMessage } from './session-context-view-port';

interface ReplaySourceConfig {
  readonly cwd: string;
  readonly modelAlias?: string;
  readonly provider?: { readonly model?: string };
  readonly modelCapabilities: TUIReplayAgentConfig['modelCapabilities'];
  readonly profileName?: string;
  readonly thinkingLevel?: string;
  readonly thinkingEffort?: string;
  readonly systemPrompt: string;
}

interface ReplaySourceConfigUpdate {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel?: string;
  readonly thinkingEffort?: string;
  readonly systemPrompt?: string;
}

type ReplaySourceRecord =
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
      readonly config: ReplaySourceConfigUpdate;
    }
  | {
      readonly type: 'permission_updated';
      readonly time: number;
      readonly mode: TUIReplayPermission['mode'];
    }
  | {
      readonly type: 'approval_result';
      readonly time: number;
      readonly record: TUIReplayApprovalRecord;
    };

export interface TUIAgentReplaySource {
  readonly type: 'main' | 'sub' | 'independent';
  readonly config: ReplaySourceConfig;
  readonly context: {
    readonly history: readonly TUIReplayContextMessage[];
    readonly tokenCount: number;
  };
  readonly replay: readonly ReplaySourceRecord[];
  readonly permission: TUIReplayPermission;
  readonly plan: TUIReplayPlan | null;
  readonly swarmMode?: boolean;
  readonly usage: AgentUsageStatus;
  readonly tools: readonly TUIReplayToolInfo[];
  readonly tasks?: readonly AgentTask[];
  readonly background?: readonly AgentTask[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
}

export function projectTUIAgentReplay(
  source: TUIAgentReplaySource,
  warning?: string,
): TUIAgentReplay {
  return {
    type: source.type,
    config: copyConfig(source.config),
    context: {
      history: source.context.history.map(copyReplayMessage),
      tokenCount: source.context.tokenCount,
    },
    replay: source.replay.map(copyReplayRecord),
    permission: copyPermission(source.permission),
    plan: copyPlan(source.plan),
    swarmMode: source.swarmMode,
    usage: copyUsage(source.usage),
    tools: source.tools.map(copyTool),
    tasks: (source.tasks ?? source.background ?? []).map(copyTask),
    toolStore:
      source.toolStore === undefined
        ? undefined
        : copyRecord(source.toolStore),
    warning,
  };
}

function copyConfig(config: ReplaySourceConfig): TUIReplayAgentConfig {
  return {
    cwd: config.cwd,
    modelAlias: config.modelAlias,
    providerModel: config.provider?.model,
    modelCapabilities: {
      image_in: config.modelCapabilities.image_in,
      video_in: config.modelCapabilities.video_in,
      audio_in: config.modelCapabilities.audio_in,
      thinking: config.modelCapabilities.thinking,
      tool_use: config.modelCapabilities.tool_use,
      max_context_tokens: config.modelCapabilities.max_context_tokens,
      max_input_tokens: config.modelCapabilities.max_input_tokens,
      dynamically_loaded_tools:
        config.modelCapabilities.dynamically_loaded_tools,
    },
    profileName: config.profileName,
    thinkingLevel:
      config.thinkingLevel ?? config.thinkingEffort ?? 'off',
    systemPrompt: config.systemPrompt,
  };
}

function copyReplayMessage(
  message: TUIReplayContextMessage,
): TUIReplayContextMessage {
  const copied = copyTUIContextMessage(message);
  return {
    ...copied,
    origin: message.origin === undefined
      ? undefined
      : copyRecord(message.origin),
  } as TUIReplayContextMessage;
}

function copyReplayRecord(record: ReplaySourceRecord): TUIAgentReplayRecord {
  switch (record.type) {
    case 'message':
      return {
        type: 'message',
        time: record.time,
        message: copyReplayMessage(record.message),
      };
    case 'compaction':
      return {
        type: 'compaction',
        time: record.time,
        result:
          typeof record.result === 'object' && record.result !== null
            ? copyCompactionResult(record.result)
            : record.result,
        instruction: record.instruction,
      };
    case 'goal_updated':
      return {
        type: 'goal_updated',
        time: record.time,
        snapshot: copyGoal(record.snapshot),
        change: copyGoalChange(record.change),
      };
    case 'plan_updated':
      return {
        type: 'plan_updated',
        time: record.time,
        enabled: record.enabled,
      };
    case 'config_updated':
      return {
        type: 'config_updated',
        time: record.time,
        config: copyConfigUpdate(record.config),
      };
    case 'permission_updated':
      return {
        type: 'permission_updated',
        time: record.time,
        mode: record.mode,
      };
    case 'approval_result':
      return {
        type: 'approval_result',
        time: record.time,
        record: copyApprovalRecord(record.record),
      };
  }
}

function copyConfigUpdate(
  config: ReplaySourceConfigUpdate,
): TUIReplayAgentConfigUpdate {
  return {
    cwd: config.cwd,
    modelAlias: config.modelAlias,
    profileName: config.profileName,
    thinkingLevel: config.thinkingLevel ?? config.thinkingEffort,
    systemPrompt: config.systemPrompt,
  };
}

function copyCompactionResult(
  result: TUIReplayCompactionResult,
): TUIReplayCompactionResult {
  return {
    summary: result.summary,
    contextSummary: result.contextSummary,
    compactedCount: result.compactedCount,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    keptUserMessageCount: result.keptUserMessageCount,
    keptHeadUserMessageCount: result.keptHeadUserMessageCount,
    droppedCount: result.droppedCount,
  };
}

function copyGoal(goal: AgentGoal): AgentGoal {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    completionCriterion: goal.completionCriterion,
    status: goal.status,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
    budget: {
      tokenBudget: goal.budget.tokenBudget,
      turnBudget: goal.budget.turnBudget,
      wallClockBudgetMs: goal.budget.wallClockBudgetMs,
      remainingTokens: goal.budget.remainingTokens,
      remainingTurns: goal.budget.remainingTurns,
      remainingWallClockMs: goal.budget.remainingWallClockMs,
      tokenBudgetReached: goal.budget.tokenBudgetReached,
      turnBudgetReached: goal.budget.turnBudgetReached,
      wallClockBudgetReached: goal.budget.wallClockBudgetReached,
      overBudget: goal.budget.overBudget,
    },
    terminalReason: goal.terminalReason,
  };
}

function copyGoalChange(change: TUIReplayGoalChange): TUIReplayGoalChange {
  if (change.kind === 'created') return { kind: 'created' };
  return {
    kind: change.kind,
    status: change.status,
    reason: change.reason,
    stats:
      change.stats === undefined
        ? undefined
        : {
            turnsUsed: change.stats.turnsUsed,
            tokensUsed: change.stats.tokensUsed,
            wallClockMs: change.stats.wallClockMs,
          },
    actor: change.actor,
  };
}

function copyApprovalRecord(
  record: TUIReplayApprovalRecord,
): TUIReplayApprovalRecord {
  return {
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    action: record.action,
    sessionApprovalRule: record.sessionApprovalRule,
    result: {
      decision: record.result.decision,
      scope: record.result.scope,
      feedback: record.result.feedback,
      selectedLabel: record.result.selectedLabel,
    },
  };
}

function copyPermission(permission: TUIReplayPermission): TUIReplayPermission {
  return {
    mode: permission.mode,
    rules: permission.rules.map((rule) => ({
      decision: rule.decision,
      scope: rule.scope,
      pattern: rule.pattern,
      reason: rule.reason,
    })),
  };
}

function copyPlan(plan: TUIReplayPlan | null): TUIReplayPlan | null {
  return plan === null
    ? null
    : {
        id: plan.id,
        content: plan.content,
        path: plan.path,
      };
}

function copyUsage(usage: AgentUsageStatus): AgentUsageStatus {
  return {
    byModel:
      usage.byModel === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(usage.byModel).map(([model, value]) => [
              model,
              { ...value },
            ]),
          ),
    currentTurn:
      usage.currentTurn === undefined ? undefined : { ...usage.currentTurn },
    total: usage.total === undefined ? undefined : { ...usage.total },
  };
}

function copyTool(tool: TUIReplayToolInfo): TUIReplayToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    parameters:
      tool.parameters === undefined ? undefined : copyRecord(tool.parameters),
    source: tool.source,
    disclosure: tool.disclosure,
    info: tool.info === undefined ? undefined : copyRecord(tool.info),
  };
}

function copyTask(task: AgentTask): AgentTask {
  return {
    taskId: task.taskId,
    kind: task.kind,
    description: task.description,
    status: task.status,
    detached: task.detached,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    stopReason: task.stopReason,
    timeoutMs: task.timeoutMs,
    command: task.command,
    pid: task.pid,
    exitCode: task.exitCode,
    agentId: task.agentId,
    subagentType: task.subagentType,
    questionCount: task.questionCount,
    toolCallId: task.toolCallId,
  };
}

function copyRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, copyValue(nested)]),
  );
}

function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (typeof value !== 'object' || value === null) return value;
  return copyRecord(value as Readonly<Record<string, unknown>>);
}
