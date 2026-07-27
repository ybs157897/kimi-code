/**
 * `replayView` domain (L5) — folds persisted wire facts into replay DTOs.
 *
 * Rebuilds the ordered legacy-compatible replay timeline without executing
 * live domain behavior. Scope-agnostic.
 */

import { buildContextCompactionShape } from '#/agent/contextMemory/compactionHandoff';
import {
  computeUndoCut,
  contextAppendLoopEvent,
  contextAppendMessage,
  contextApplyCompaction,
  contextUndo,
  foldSwarmModeExit,
  readContextCompactionShapeInput,
} from '#/agent/contextMemory/contextOps';
import {
  foldAppendMessage,
  foldLoopEvent,
  resetFold,
} from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  clearGoal,
  createGoal,
  forkGoal,
  type GoalState,
  updateGoal,
} from '#/agent/goal/goalOps';
import type {
  GoalBudgetReport,
  GoalChange,
  GoalSnapshot,
} from '#/agent/goal/types';
import { configUpdate } from '#/agent/profile/profileOps';
import type {
  AgentReplayRecord,
  AgentReplayRecordPayload,
} from '#/agent/replayBuilder/types';
import { fullCompactionBegin } from '#/agent/fullCompaction/compactionOps';
import { planModeCancel, planModeEnter, planModeExit } from '#/agent/plan/planOps';
import { setMode } from '#/agent/permissionMode/permissionModeOps';
import { recordApprovalResult } from '#/agent/permissionRules/permissionRulesOps';
import { swarmExit } from '#/agent/swarm/swarmOps';
import type { OpDescriptor } from '#/wire/op';
import type { WireRecord } from '#/wire/record';
import { wireRecordToPayload } from '#/wire/record';

type MutableReplayRecord = { time: number } & AgentReplayRecordPayload;
type MutableMessageReplayRecord = Extract<MutableReplayRecord, { type: 'message' }>;

type RemovalMode = 'deactivate' | 'retain';
type AdditionMode = 'record' | 'ignore';

export function buildAgentReplayRecords(
  wireRecords: readonly WireRecord[],
): readonly AgentReplayRecord[] {
  const replay: MutableReplayRecord[] = [];
  const activeMessages = new Set<MutableMessageReplayRecord>();
  const messageRecords = new Map<ContextMessage, MutableMessageReplayRecord>();
  const messageTimes = new Map<ContextMessage, number>();
  let context = resetFold([]);
  let goal: GoalState | null = null;

  const push = (record: WireRecord, payload: AgentReplayRecordPayload): void => {
    replay.push({ ...payload, time: replayTime(record) } as MutableReplayRecord);
  };

  const reconcileContext = (
    next: readonly ContextMessage[],
    time: number | undefined,
    removalMode: RemovalMode,
    additionMode: AdditionMode,
  ): void => {
    const before = context;
    const beforeSet = new Set(before);
    const nextSet = new Set(next);

    for (let index = 0; index < Math.min(before.length, next.length); index++) {
      const previous = before[index]!;
      const current = next[index]!;
      if (
        previous === current ||
        nextSet.has(previous) ||
        messageRecords.has(current) ||
        previous.role !== 'assistant' ||
        current.role !== 'assistant' ||
        previous.partial !== true
      ) {
        continue;
      }
      const replayRecord = messageRecords.get(previous);
      if (replayRecord === undefined) continue;
      messageRecords.delete(previous);
      messageRecords.set(current, replayRecord);
      replayRecord.message = current;
    }

    for (const message of before) {
      if (nextSet.has(message)) continue;
      const replayRecord = messageRecords.get(message);
      if (replayRecord === undefined) continue;
      messageRecords.delete(message);
      if (removalMode === 'deactivate') activeMessages.delete(replayRecord);
    }

    if (additionMode === 'record') {
      for (const message of next) {
        if (beforeSet.has(message) || messageRecords.has(message)) continue;
        const replayRecord: MutableMessageReplayRecord = {
          type: 'message',
          message,
          time: messageTimes.get(message) ?? requiredReplayTime(time, 'context message'),
        };
        messageRecords.set(message, replayRecord);
        activeMessages.add(replayRecord);
        replay.push(replayRecord);
      }
    }
    context = next;
  };

  for (const record of wireRecords) {
    switch (record.type) {
      case 'metadata':
        break;
      case 'context.append_message': {
        const payload = parsePayload(record, contextAppendMessage);
        if (payload === undefined) break;
        const time = replayTime(record);
        messageTimes.set(payload.message, time);
        reconcileContext(
          foldAppendMessage(context, payload.message),
          time,
          'deactivate',
          'record',
        );
        break;
      }
      case 'context.append_loop_event': {
        const payload = parsePayload(record, contextAppendLoopEvent);
        if (payload === undefined) break;
        const time = replayTime(record);
        reconcileContext(
          foldLoopEvent(context, payload.event),
          time,
          'deactivate',
          'record',
        );
        break;
      }
      case 'context.apply_compaction': {
        const payload = parsePayload(record, contextApplyCompaction);
        if (payload === undefined) break;
        const shape = buildContextCompactionShape(
          context,
          readContextCompactionShapeInput(payload),
        );
        const last = replay.at(-1);
        if (last?.type === 'compaction') {
          last.result = {
            summary: shape.summary,
            contextSummary: shape.contextSummary,
            compactedCount: shape.compactedCount,
            tokensBefore: shape.tokensBefore,
            tokensAfter: shape.tokensAfter,
            keptUserMessageCount: shape.keptUserMessageCount,
            keptHeadUserMessageCount: shape.keptHeadUserMessageCount,
            droppedCount: shape.droppedCount,
          };
        }
        reconcileContext(shape.messages, record.time, 'retain', 'ignore');
        break;
      }
      case 'context.undo': {
        const payload = parsePayload(record, contextUndo);
        if (payload === undefined) break;
        const cut = computeUndoCut(context, payload.count);
        const next =
          cut.cutIndex >= 0 && cut.removedCount >= payload.count
            ? resetFold(context.slice(0, cut.cutIndex))
            : context;
        reconcileContext(next, record.time, 'deactivate', 'ignore');
        break;
      }
      case 'context.clear':
        reconcileContext(resetFold([]), record.time, 'retain', 'ignore');
        break;
      case 'full_compaction.begin': {
        const payload = parsePayload(record, fullCompactionBegin);
        if (payload !== undefined) {
          push(record, { type: 'compaction', instruction: payload.instruction });
        }
        break;
      }
      case 'full_compaction.cancel': {
        const last = replay.at(-1);
        if (last?.type === 'compaction') last.result = 'cancelled';
        break;
      }
      case 'goal.create': {
        const payload = parsePayload(record, createGoal);
        if (payload === undefined) break;
        goal = createGoal.apply(goal, payload);
        if (goal === null) break;
        push(record, {
          type: 'goal_updated',
          snapshot: goalSnapshot(goal),
          change: { kind: 'created' },
        });
        break;
      }
      case 'goal.update': {
        const payload = parsePayload(record, updateGoal);
        if (payload === undefined || goal === null) break;
        goal = updateGoal.apply(goal, payload);
        if (goal === null || payload.status === undefined) break;
        push(record, {
          type: 'goal_updated',
          snapshot: goalSnapshot(goal),
          change: goalChange(goal, payload),
        });
        break;
      }
      case 'goal.clear': {
        const payload = parsePayload(record, clearGoal);
        if (payload !== undefined) goal = clearGoal.apply(goal, payload);
        break;
      }
      case 'forked': {
        const payload = parsePayload(record, forkGoal);
        if (payload !== undefined) goal = forkGoal.apply(goal, payload);
        break;
      }
      case 'plan_mode.enter': {
        const payload = parsePayload(record, planModeEnter);
        if (payload !== undefined) push(record, { type: 'plan_updated', enabled: true });
        break;
      }
      case 'plan_mode.cancel': {
        const payload = parsePayload(record, planModeCancel);
        if (payload !== undefined) push(record, { type: 'plan_updated', enabled: false });
        break;
      }
      case 'plan_mode.exit': {
        const payload = parsePayload(record, planModeExit);
        if (payload !== undefined) push(record, { type: 'plan_updated', enabled: false });
        break;
      }
      case 'config.update': {
        const payload = parsePayload(record, configUpdate);
        if (payload === undefined) break;
        push(record, {
          type: 'config_updated',
          config: {
            cwd: payload.cwd,
            modelAlias: payload.modelAlias,
            profileName: payload.profileName,
            thinkingLevel: payload.thinkingEffort ?? payload.thinkingLevel,
            systemPrompt: payload.systemPrompt,
          },
        });
        break;
      }
      case 'permission.set_mode': {
        const payload = parsePayload(record, setMode);
        if (payload !== undefined) {
          push(record, { type: 'permission_updated', mode: payload.mode });
        }
        break;
      }
      case 'permission.record_approval_result': {
        const payload = parsePayload(record, recordApprovalResult);
        if (payload !== undefined) {
          push(record, { type: 'approval_result', record: payload });
        }
        break;
      }
      case 'swarm_mode.exit': {
        const payload = parsePayload(record, swarmExit);
        if (payload === undefined) break;
        reconcileContext(
          foldSwarmModeExit([...context], payload),
          record.time,
          'retain',
          'ignore',
        );
        break;
      }
      default:
        break;
    }
  }

  return replay.filter(
    (record) => record.type !== 'message' || activeMessages.has(record),
  ) as AgentReplayRecord[];
}

function parsePayload<S, P>(
  record: WireRecord,
  descriptor: OpDescriptor<string, S, P>,
): P | undefined {
  const parsed = descriptor.schema.safeParse(wireRecordToPayload(record));
  return parsed.success ? parsed.data : undefined;
}

function replayTime(record: WireRecord): number {
  return requiredReplayTime(record.time, record.type);
}

function requiredReplayTime(time: number | undefined, type: string): number {
  if (time !== undefined) return time;
  throw new Error(`Cannot project replay record '${type}' without a timestamp`);
}

function goalSnapshot(state: GoalState): GoalSnapshot {
  const wallClockMs = state.wallClockMs;
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion,
    status: state.status,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs,
    budget: goalBudget(state, wallClockMs),
    terminalReason: state.terminalReason,
  };
}

function goalBudget(state: GoalState, wallClockMs: number): GoalBudgetReport {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;
  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;
  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function goalChange(
  state: GoalState,
  payload: ReturnType<typeof updateGoal>['payload'],
): GoalChange {
  if (payload.status === 'complete') {
    return {
      kind: 'completion',
      status: payload.status,
      reason: payload.reason,
      stats: {
        turnsUsed: state.turnsUsed,
        tokensUsed: state.tokensUsed,
        wallClockMs: state.wallClockMs,
      },
      actor: payload.actor,
    };
  }
  return {
    kind: 'lifecycle',
    status: payload.status,
    reason: payload.reason,
    actor: payload.actor,
  };
}
