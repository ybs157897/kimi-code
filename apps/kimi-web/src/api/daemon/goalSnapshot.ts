// apps/kimi-web/src/api/daemon/goalSnapshot.ts
// Maps a raw goal.updated snapshot payload into an AppGoal.

import type { AppGoal } from '../types';
import { nullableNumberField, numberField, stringField } from './projectorHelpers';

export function mapGoalSnapshot(snapshot: unknown): AppGoal | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const budgetRaw = s['budget'];
  const budget = budgetRaw && typeof budgetRaw === 'object' ? budgetRaw as Record<string, unknown> : {};
  const status = stringField(s, 'status');
  if (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete') return null;
  const goalId = stringField(s, 'goalId') ?? stringField(s, 'goal_id') ?? 'goal';
  const objective = stringField(s, 'objective') ?? '';
  return {
    goalId,
    objective,
    completionCriterion: stringField(s, 'completionCriterion') ?? stringField(s, 'completion_criterion'),
    status,
    turnsUsed: numberField(s, 'turnsUsed') ?? numberField(s, 'turns_used') ?? 0,
    tokensUsed: numberField(s, 'tokensUsed') ?? numberField(s, 'tokens_used') ?? 0,
    wallClockMs: numberField(s, 'wallClockMs') ?? numberField(s, 'wall_clock_ms') ?? 0,
    terminalReason: stringField(s, 'terminalReason') ?? stringField(s, 'terminal_reason'),
    budget: {
      tokenBudget: nullableNumberField(budget, 'tokenBudget') ?? nullableNumberField(budget, 'token_budget'),
      remainingTokens: nullableNumberField(budget, 'remainingTokens') ?? nullableNumberField(budget, 'remaining_tokens'),
      turnBudget: nullableNumberField(budget, 'turnBudget') ?? nullableNumberField(budget, 'turn_budget'),
      remainingTurns: nullableNumberField(budget, 'remainingTurns') ?? nullableNumberField(budget, 'remaining_turns'),
      wallClockBudgetMs: nullableNumberField(budget, 'wallClockBudgetMs') ?? nullableNumberField(budget, 'wall_clock_budget_ms'),
      remainingWallClockMs: nullableNumberField(budget, 'remainingWallClockMs') ?? nullableNumberField(budget, 'remaining_wall_clock_ms'),
      overBudget: budget['overBudget'] === true || budget['over_budget'] === true,
    },
  };
}
