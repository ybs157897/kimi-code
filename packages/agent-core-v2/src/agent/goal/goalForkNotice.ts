/**
 * `goal` domain (L4) — fork-boundary goal notice Model.
 *
 * The `goalForkNotice` wire Model tracks whether a goal is present and whether
 * a fork-cleared reminder is pending, so a forked session can inject the
 * reminder once and clear it when the message lands in context memory.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';
import { defineModel } from '#/wire/model';

import { GOAL_FORK_CLEARED_REMINDER_NAME } from './goalConstants';

interface GoalForkNoticeState {
  readonly goalPresent: boolean;
  readonly reminderPending: boolean;
}

export const GoalForkNoticeModel = defineModel<GoalForkNoticeState>(
  'goalForkNotice',
  () => ({ goalPresent: false, reminderPending: false }),
  {
    reducers: {
      'goal.create': (state) => ({ ...state, goalPresent: true }),
      'goal.clear': (state) => ({ ...state, goalPresent: false }),
      forked: (state) => ({
        goalPresent: false,
        reminderPending: state.goalPresent || state.reminderPending,
      }),
      'context.append_message': (state, payload: { message?: ContextMessage }) =>
        state.reminderPending && isGoalForkClearedReminder(payload.message)
          ? { ...state, reminderPending: false }
          : state,
    },
  },
);

export function isGoalForkClearedReminder(message: ContextMessage | undefined): boolean {
  return (
    message?.origin?.kind === 'system_trigger' &&
    message.origin.name === GOAL_FORK_CLEARED_REMINDER_NAME
  );
}
