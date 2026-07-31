// apps/kimi-web/src/composables/client/localTurnLifecycle.ts
// Per-session local-turn-start lifecycle and prompt-queue flush failure
// tracking, shared by every entry point that starts a turn locally (prompt
// submit/steer in useWorkspaceState, skill activation in
// useModelProviderState).

/**
 * Per-session local-turn-start lifecycle, shared by EVERY entry point that
 * starts a turn locally (prompt submit/steer in useWorkspaceState, skill
 * activation in useModelProviderState). Two pieces of state:
 *  - generation: bumped synchronously at every local turn start, so a
 *    snapshot requested BEFORE the start can tell it predates the turn;
 *  - pending: set while the start request (POST /prompts or skill
 *    activation) has not been acknowledged by the daemon — a snapshot
 *    requested in that window cannot reflect the turn server-side either.
 * Module-level singleton — matches `inFlightBySession` on rawState.
 */
const promptGenerationBySession = new Map<string, number>();
const pendingLocalTurnStarts = new Map<string, Set<number>>();
const afterLocalTurnsSettled = new Map<string, () => void>();
let nextLocalTurnToken = 0;

/**
 * Consecutive flushQueueHead failures per queue ENTRY (not per session) —
 * keyed by entry id, falling back to its text for entries without one.
 * Keying by entry keeps a removed or reordered head from handing its
 * failure budget down to the next entry. Module-level singleton — the queue
 * itself is per-session on rawState, so a page reload resets both.
 */
export const queueFlushFailures = new Map<string, { key: string; count: number }>();
export const MAX_QUEUE_FLUSH_FAILURES = 3;

let queueEntryCounter = 0;
export function nextQueueEntryId(): string {
  queueEntryCounter += 1;
  return `${Date.now().toString(36)}-${queueEntryCounter}`;
}

export interface LocalTurnStartState {
  generation: number;
  pending: boolean;
}

/** Snapshot of the local-turn-start state, captured BEFORE an async snapshot
 *  fetch so the caller can reject a snapshot that predates a local turn. */
export function localTurnStartState(sid: string): LocalTurnStartState {
  return {
    generation: promptGenerationBySession.get(sid) ?? 0,
    pending: (pendingLocalTurnStarts.get(sid)?.size ?? 0) > 0,
  };
}

/** Shared "a local turn just started" lifecycle: bumps the generation and
 *  marks the start request pending. Call synchronously before the first
 *  await of every local turn entry point. */
export function beginLocalTurn(sid: string): number {
  const token = ++nextLocalTurnToken;
  promptGenerationBySession.set(sid, token);
  const pending = pendingLocalTurnStarts.get(sid) ?? new Set<number>();
  pending.add(token);
  pendingLocalTurnStarts.set(sid, pending);
  return token;
}

/** The daemon acknowledged (or rejected) the turn-start request. */
export function settleLocalTurn(sid: string, token: number): void {
  const pending = pendingLocalTurnStarts.get(sid);
  if (pending === undefined) return;
  pending.delete(token);
  if (pending.size > 0) return;
  pendingLocalTurnStarts.delete(sid);
  const callback = afterLocalTurnsSettled.get(sid);
  afterLocalTurnsSettled.delete(sid);
  callback?.();
}

/** Drop lifecycle state with the rest of a forgotten session. */
export function forgetLocalTurnState(sid: string): void {
  promptGenerationBySession.delete(sid);
  pendingLocalTurnStarts.delete(sid);
  afterLocalTurnsSettled.delete(sid);
  queueFlushFailures.delete(sid);
}

/** Whether a snapshot request can still be applied without overwriting a
 *  local turn that started before or during the request. */
export function isLocalTurnSnapshotCurrent(sid: string, atRequest: LocalTurnStartState): boolean {
  return !atRequest.pending && atRequest.generation === (promptGenerationBySession.get(sid) ?? 0);
}

/** Coalesce a skipped snapshot into one retry after local turn-start requests settle. */
export function afterLocalTurnStartsSettle(sid: string, callback: () => void): void {
  if ((pendingLocalTurnStarts.get(sid)?.size ?? 0) === 0) {
    callback();
    return;
  }
  afterLocalTurnsSettled.set(sid, callback);
}
