import type { Session } from '@moonshot-ai/kimi-code-sdk';

import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  updateGoalQueueItem,
} from '../goal-queue-store';
import type {
  GoalQueueSnapshot,
  SessionGoalQueuePort,
} from './session-goal-queue-port';

type LegacySessionSummary = Pick<
  NonNullable<Session['summary']>,
  'sessionDir'
>;

interface LegacySessionGoalQueueSession {
  readonly id: Session['id'];
  readonly summary?: LegacySessionSummary;
}

/** Bridge one active legacy Session into the runtime-neutral goal queue. */
export function createLegacySessionGoalQueuePort(
  session: LegacySessionGoalQueueSession,
): SessionGoalQueuePort {
  return {
    read: async () => copySnapshot(await readGoalQueue(session)),
    append: async (input) =>
      copySnapshot(
        await appendGoalQueueItem(session, { objective: input.objective }),
      ),
    update: async (input) =>
      copySnapshot(
        await updateGoalQueueItem(session, {
          goalId: input.goalId,
          objective: input.objective,
        }),
      ),
    remove: async (input) =>
      copySnapshot(
        await removeGoalQueueItem(session, { goalId: input.goalId }),
      ),
    restore: async (goal) =>
      copySnapshot(
        await restoreGoalQueueItem(session, {
          id: goal.id,
          objective: goal.objective,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
        }),
      ),
    move: async (input) =>
      copySnapshot(
        await moveGoalQueueItem(session, {
          goalId: input.goalId,
          direction: input.direction,
        }),
      ),
  };
}

function copySnapshot(snapshot: GoalQueueSnapshot): GoalQueueSnapshot {
  return {
    goals: snapshot.goals.map((goal) => ({
      id: goal.id,
      objective: goal.objective,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    })),
  };
}
