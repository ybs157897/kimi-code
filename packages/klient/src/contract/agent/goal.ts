/**
 * Agent goal control-plane contract. Only the user-facing lifecycle methods
 * cross the wire; runtime/model-only accounting and completion methods remain
 * private to the engine.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);

export const goalBudgetReportSchema = z.object({
  tokenBudget: z.number().nullable(),
  turnBudget: z.number().nullable(),
  wallClockBudgetMs: z.number().nullable(),
  remainingTokens: z.number().nullable(),
  remainingTurns: z.number().nullable(),
  remainingWallClockMs: z.number().nullable(),
  tokenBudgetReached: z.boolean(),
  turnBudgetReached: z.boolean(),
  wallClockBudgetReached: z.boolean(),
  overBudget: z.boolean(),
});

export const goalSnapshotSchema = z.object({
  goalId: z.string(),
  objective: z.string(),
  completionCriterion: z.string().optional(),
  status: goalStatusSchema,
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  wallClockMs: z.number(),
  budget: goalBudgetReportSchema,
  terminalReason: z.string().optional(),
});

export const goalToolResultSchema = z.object({
  goal: goalSnapshotSchema.nullable(),
});

export const createGoalInputSchema = z.object({
  objective: z.string(),
  completionCriterion: z.string().optional(),
  replace: z.boolean().optional(),
});

export const goalReasonInputSchema = z.object({
  reason: z.string().optional(),
});

export const resumeGoalInputSchema = goalReasonInputSchema.extend({
  continueIfPaused: z.boolean().optional(),
  continueIfBlocked: z.boolean().optional(),
});

export const agentGoalContract = {
  getGoal: { input: z.tuple([]), output: goalToolResultSchema },
  createGoal: {
    input: z.tuple([createGoalInputSchema]),
    output: goalSnapshotSchema,
  },
  pauseGoal: {
    input: z.tuple([goalReasonInputSchema.optional()]),
    output: goalSnapshotSchema,
  },
  resumeGoal: {
    input: z.tuple([resumeGoalInputSchema.optional()]),
    output: goalSnapshotSchema,
  },
  cancelGoal: {
    input: z.tuple([goalReasonInputSchema.optional()]),
    output: goalSnapshotSchema,
  },
} satisfies ServiceContract;
