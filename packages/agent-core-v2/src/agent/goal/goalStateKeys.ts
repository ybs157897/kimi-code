/**
 * `goal` domain (L4) — agent-state keys for live goal turn tracking.
 *
 * The mutable turn-tracking and wall-clock state the goal service registers
 * into `agentState` (`IAgentStateService`) and reads/writes through it.
 */

import { defineState } from '#/_base/state/stateRegistry';

export interface ResumeContinuation {
  readonly turnId: number;
  readonly goalId: string;
}

export const goalLiveTurnIdKey = defineState<number | undefined>(
  'goal.liveTurnId',
  () => undefined as number | undefined,
);
export const goalGoalDrivenTurnsKey = defineState<Map<number, string>>(
  'goal.goalDrivenTurns',
  () => new Map(),
);
export const goalCountedGoalTurnsKey = defineState<Set<number>>(
  'goal.countedGoalTurns',
  () => new Set(),
);
export const goalGoalStarterTurnsKey = defineState<Set<number>>(
  'goal.goalStarterTurns',
  () => new Set(),
);
export const goalGoalOutcomeToolResultTurnsKey = defineState<Map<number, string>>(
  'goal.goalOutcomeToolResultTurns',
  () => new Map(),
);
export const goalGoalOutcomeContinuationTurnsKey = defineState<Set<number>>(
  'goal.goalOutcomeContinuationTurns',
  () => new Set(),
);
export const goalBudgetGraceTurnsKey = defineState<Set<number>>(
  'goal.budgetGraceTurns',
  () => new Set(),
);
export const goalPendingContinuationGoalsKey = defineState<Map<number, string>>(
  'goal.pendingContinuationGoals',
  () => new Map(),
);
export const goalGoalTurnTargetsKey = defineState<Map<number, string>>(
  'goal.goalTurnTargets',
  () => new Map(),
);
export const goalExhaustedTurnBudgetGoalsKey = defineState<Map<number, string>>(
  'goal.exhaustedTurnBudgetGoals',
  () => new Map(),
);
export const goalLiveWallClockStartedAtKey = defineState<number | undefined>(
  'goal.liveWallClockStartedAt',
  () => undefined as number | undefined,
);
export const goalResumeContinuationKey = defineState<ResumeContinuation | undefined>(
  'goal.resumeContinuation',
  () => undefined as ResumeContinuation | undefined,
);
