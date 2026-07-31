// apps/kimi-web/src/composables/client/pendingActions.ts
// In-flight action guards shared by the workspace-state composables.

import { reactive } from 'vue';

/**
 * Question ids with an in-flight respond/dismiss, keyed by questionId with the
 * action kind. Drives the card's loading state and guards against a duplicate
 * submit while the first request is still in flight (the server would reject
 * the second resolve with 40902). Module-level singleton — matches
 * `inFlightBySession` on rawState.
 */
export const pendingQuestionActions = reactive<Record<string, 'answer' | 'dismiss'>>({});
/** Approval ids with an in-flight respond, keyed by approvalId. */
export const pendingApprovalActions = reactive<Record<string, true>>({});
/** Task ids with an in-flight cancel, keyed by taskId. */
export const pendingTaskCancellations = reactive<Record<string, true>>({});
/**
 * Workspace ids whose empty-session first prompt is currently being created +
 * submitted. The empty-composer path (`startSessionAndSendPrompt`) awaits
 * `createDraftSession` (addWorkspace + createSession + selectSession) before
 * the session id exists, so the per-session prompt-in-flight guard cannot
 * cover that window — a second Enter / send-button click during it
 * would otherwise fire a second concurrent POST and trip the daemon's
 * `turn.agent_busy` race. Module-level singleton — matches the other
 * `pending*Actions` guards above.
 */
export const startingFirstPromptWorkspaces = reactive(new Set<string>());
