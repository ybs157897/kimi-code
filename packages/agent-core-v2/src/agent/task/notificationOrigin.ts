/**
 * `task` domain (L5) — task terminal-notification identity and delivery
 * tracking: the `TaskNotificationOrigin` guard and key helpers that name a
 * notification by its context-message origin, and the checkpointed
 * `TaskNotificationDeliveryModel` that records delivered notification keys so
 * delivery follows conversation undo through the checkpoint contract.
 */

import { defineCheckpointedModel } from '#/agent/contextMemory/conversationTime';
import type { TaskOrigin } from '#/agent/contextMemory/types';

export const TaskNotificationDeliveryModel = defineCheckpointedModel(
  'task.notificationDelivery',
  (): readonly string[] => [],
  {
    onAppendMessage: (current, message) => {
      const origin = taskOriginFromMessage(message);
      if (origin === undefined) return current;
      const key = notificationKey(origin);
      return current.includes(key) ? current : [...current, key];
    },
  },
);

export type TaskNotificationOrigin = Pick<TaskOrigin, 'taskId' | 'status' | 'notificationId'>;

export function isTaskOrigin(origin: unknown): origin is TaskNotificationOrigin {
  if (typeof origin !== 'object' || origin === null) return false;
  const value = origin as Record<string, unknown>;
  return (
    (value['kind'] === 'background_task' || value['kind'] === 'task') &&
    typeof value['taskId'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['notificationId'] === 'string'
  );
}

export function notificationKey(origin: TaskNotificationOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

function taskOriginFromMessage(message: unknown): TaskNotificationOrigin | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  return isTaskOrigin(origin) ? origin : undefined;
}
