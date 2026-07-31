// apps/kimi-web/src/composables/client/workspaceErrors.ts
// Daemon error codes + predicates shared by the workspace-state composables:
// benign "already in the desired end state" conflicts and not-found codes.

import { isDaemonApiError } from '../../api/errors';

export const PROMPT_NOT_FOUND_CODE = 40402;
export const WORKSPACE_NOT_FOUND_CODE = 40410;
// Shared "already resolved" conflict (40902). The daemon reuses it for both
// approvals and questions when a second client races the resolve, so a
// duplicate submit is reported as a conflict even though the desired end
// state (resolved) is already reached. We treat it as a benign no-op.
const ALREADY_RESOLVED_CODE = 40902;

export function isAlreadyResolvedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === ALREADY_RESOLVED_CODE;
}

// 40904 — cancel raced the task reaching a terminal state. Like 40902 this is
// an idempotent "already in the desired end state" conflict, not a real error.
const TASK_ALREADY_FINISHED_CODE = 40904;

export function isTaskAlreadyFinishedError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === TASK_ALREADY_FINISHED_CODE;
}
