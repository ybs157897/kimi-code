/**
 * Runtime-neutral upcoming-goal queue for one active session.
 *
 * Dates remain wire strings. Promotion into the active goal is owned by the
 * caller, not this persistence-only boundary.
 */

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

export interface SessionGoalQueuePort {
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
