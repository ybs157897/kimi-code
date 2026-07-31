/**
 * `task` domain (L5) — task termination primitives: the SIGTERM grace period
 * before SIGKILL escalation, the session-close stop reason, and stop-reason
 * normalization.
 */

export const SIGTERM_GRACE_MS = 5_000;
export const SESSION_CLOSED_REASON = 'Session closed';

export function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
