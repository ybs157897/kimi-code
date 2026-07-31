/**
 * `goal` domain (L4) — goal budget helpers.
 *
 * Pure functions that compute the budget report from a `GoalState`, derive
 * the budget-blocked lifecycle reason, and project budget limits into
 * telemetry properties.
 */

import type { GoalBudgetProperties } from '#/app/telemetry/events';

import { GOAL_BUDGET_BLOCK_PREFIX } from './goalConstants';
import type { GoalState } from './goalOps';
import type { GoalBudgetLimits, GoalBudgetReport } from './types';

export function computeBudgetReport(state: GoalState, wallClockMs: number): GoalBudgetReport {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached = wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

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

export function goalBudgetBlockReason(budget: GoalBudgetReport): string | undefined {
  const reached: string[] = [];
  if (budget.turnBudgetReached) {
    reached.push(`turn budget ${budget.turnBudget ?? ''}`.trim());
  }
  if (budget.tokenBudgetReached) {
    reached.push(`token budget ${budget.tokenBudget ?? ''}`.trim());
  }
  if (budget.wallClockBudgetReached) {
    reached.push(`wall-clock budget ${budget.wallClockBudgetMs ?? ''}ms`.trim());
  }
  return reached.length === 0 ? undefined : `${GOAL_BUDGET_BLOCK_PREFIX}: ${reached.join(', ')}`;
}

export function budgetTelemetryProperties(limits: GoalBudgetLimits): GoalBudgetProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}
