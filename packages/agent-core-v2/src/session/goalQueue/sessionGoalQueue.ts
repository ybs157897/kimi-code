/**
 * `goalQueue` domain (L4) — session upcoming-goal queue contract.
 *
 * Owns the durable, ordered queue of goals that have not yet been promoted
 * into an agent's active goal lifecycle. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface UpcomingGoal {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalQueueSnapshot {
  readonly goals: readonly UpcomingGoal[];
}

export type GoalQueueMoveDirection = 'up' | 'down';

export interface ISessionGoalQueueService {
  readonly _serviceBrand: undefined;

  read(): Promise<GoalQueueSnapshot>;
  append(input: { readonly objective: string }): Promise<GoalQueueSnapshot>;
  update(input: {
    readonly goalId: string;
    readonly objective: string;
  }): Promise<GoalQueueSnapshot>;
  remove(input: { readonly goalId: string }): Promise<GoalQueueSnapshot>;
  restore(goal: UpcomingGoal): Promise<GoalQueueSnapshot>;
  move(input: {
    readonly goalId: string;
    readonly direction: GoalQueueMoveDirection;
  }): Promise<GoalQueueSnapshot>;
}

export const ISessionGoalQueueService: ServiceIdentifier<ISessionGoalQueueService> =
  createDecorator<ISessionGoalQueueService>('sessionGoalQueueService');
