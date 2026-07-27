/**
 * `sessionGoalQueueService` — durable upcoming-goal queue contract.
 *
 * Dates remain their wire string representation; Klient does not parse them
 * into process-local `Date` objects.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const upcomingGoalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const goalQueueSnapshotSchema = z.object({
  goals: z.array(upcomingGoalSchema),
});

export const goalQueueMoveDirectionSchema = z.enum(['up', 'down']);

export const appendGoalQueueInputSchema = z.object({
  objective: z.string(),
});

export const updateGoalQueueInputSchema = z.object({
  goalId: z.string(),
  objective: z.string(),
});

export const removeGoalQueueInputSchema = z.object({
  goalId: z.string(),
});

export const moveGoalQueueInputSchema = z.object({
  goalId: z.string(),
  direction: goalQueueMoveDirectionSchema,
});

export const sessionGoalQueueContract = {
  read: {
    input: z.tuple([]),
    output: goalQueueSnapshotSchema,
  },
  append: {
    input: z.tuple([appendGoalQueueInputSchema]),
    output: goalQueueSnapshotSchema,
  },
  update: {
    input: z.tuple([updateGoalQueueInputSchema]),
    output: goalQueueSnapshotSchema,
  },
  remove: {
    input: z.tuple([removeGoalQueueInputSchema]),
    output: goalQueueSnapshotSchema,
  },
  restore: {
    input: z.tuple([upcomingGoalSchema]),
    output: goalQueueSnapshotSchema,
  },
  move: {
    input: z.tuple([moveGoalQueueInputSchema]),
    output: goalQueueSnapshotSchema,
  },
} satisfies ServiceContract;
