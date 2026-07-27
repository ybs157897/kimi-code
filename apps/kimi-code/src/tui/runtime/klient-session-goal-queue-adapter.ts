import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  GoalQueueSnapshot,
  SessionGoalQueuePort,
} from './session-goal-queue-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;

interface KlientSessionGoalQueueFacade {
  readonly goalQueue: {
    read(): ReturnType<KlientSessionFacade['goalQueue']['read']>;
    append(
      input: Parameters<KlientSessionFacade['goalQueue']['append']>[0],
    ): ReturnType<KlientSessionFacade['goalQueue']['append']>;
    update(
      input: Parameters<KlientSessionFacade['goalQueue']['update']>[0],
    ): ReturnType<KlientSessionFacade['goalQueue']['update']>;
    remove(
      input: Parameters<KlientSessionFacade['goalQueue']['remove']>[0],
    ): ReturnType<KlientSessionFacade['goalQueue']['remove']>;
    restore(
      goal: Parameters<KlientSessionFacade['goalQueue']['restore']>[0],
    ): ReturnType<KlientSessionFacade['goalQueue']['restore']>;
    move(
      input: Parameters<KlientSessionFacade['goalQueue']['move']>[0],
    ): ReturnType<KlientSessionFacade['goalQueue']['move']>;
  };
}

/** Bridge one Klient session facade into the runtime-neutral goal queue. */
export function createKlientSessionGoalQueuePort(
  session: KlientSessionGoalQueueFacade,
): SessionGoalQueuePort {
  return {
    read: async () => copySnapshot(await session.goalQueue.read()),
    append: async (input) =>
      copySnapshot(
        await session.goalQueue.append({ objective: input.objective }),
      ),
    update: async (input) =>
      copySnapshot(
        await session.goalQueue.update({
          goalId: input.goalId,
          objective: input.objective,
        }),
      ),
    remove: async (input) =>
      copySnapshot(
        await session.goalQueue.remove({ goalId: input.goalId }),
      ),
    restore: async (goal) =>
      copySnapshot(
        await session.goalQueue.restore({
          id: goal.id,
          objective: goal.objective,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
        }),
      ),
    move: async (input) =>
      copySnapshot(
        await session.goalQueue.move({
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
