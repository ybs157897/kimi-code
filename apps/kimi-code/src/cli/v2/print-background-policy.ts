/**
 * Print-mode liveness policy shared by v2 hosts.
 *
 * This module is deliberately transport-neutral: callers provide snapshots of
 * goal, cron, and task state plus a turn-ending stream. It has no DI Scope or
 * engine Service dependencies, so SDK/Klient hosts can reuse the exact policy
 * without importing the native composition root.
 */

const GOAL_WAIT_POLL_MS = 250;
const CRON_FIRE_GRACE_MS = 5_000;

export type PrintBackgroundMode = 'exit' | 'drain' | 'steer';

export interface PrintTurnEnding {
  readonly type: 'turn.ended';
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: unknown;
}

/**
 * Source of `turn.ended` events for the print steer loop. `next` resolves with
 * the next ending (skipping `skipTurnId`, the main turn's own buffered
 * ending), or `null` when `remainingMs` elapses first.
 */
export interface PrintTurnEndings {
  next(remainingMs: number, skipTurnId: number): Promise<PrintTurnEnding | null>;
}

/**
 * Buffered collector for hosts that receive turn endings from a push event
 * stream. Endings that arrive before the policy starts waiting are retained.
 */
export function createPrintTurnEndings(): PrintTurnEndings & {
  push: (event: PrintTurnEnding) => void;
} {
  const buffer: PrintTurnEnding[] = [];
  let waiter: ((ending: PrintTurnEnding | null) => void) | undefined;
  return {
    push: (event) => {
      const resolve = waiter;
      if (resolve !== undefined) {
        waiter = undefined;
        resolve(event);
        return;
      }
      buffer.push(event);
    },
    next: async (remainingMs, skipTurnId) => {
      const deadlineAt = Date.now() + remainingMs;
      const waitOnce = (ms: number): Promise<PrintTurnEnding | null> =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (value: PrintTurnEnding | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiter = undefined;
            // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` is the single-settlement guard
            resolve(value);
          };
          const timer = Number.isFinite(ms)
            ? setTimeout(() => {
                settle(null);
              }, ms)
            : undefined;
          waiter = settle;
        });
      for (;;) {
        while (buffer.length > 0) {
          const ending = buffer.shift()!;
          if (ending.turnId !== skipTurnId) return ending;
        }
        const ms = deadlineAt - Date.now();
        if (ms <= 0) return null;
        const ending = await waitOnce(ms);
        if (ending === null) return null;
        if (ending.turnId !== skipTurnId) return ending;
      }
    },
  };
}

/** A background completion steered a turn that did not complete. */
export class PrintSteeredTurnFailedError extends Error {}

export interface PrintBackgroundPolicyInput {
  readonly mode: PrintBackgroundMode;
  readonly ceilingS: number;
  readonly maxTurns: number;
  readonly countPending: () => number | Promise<number>;
  readonly drain: () => Promise<void>;
  readonly turnEndings: PrintTurnEndings;
  readonly skipTurnId: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
  readonly goalActive?: () => boolean | Promise<boolean>;
  readonly cronNextFireAt?: () => number | null | Promise<number | null>;
}

/**
 * Keep print mode alive in priority order: active goal continuations,
 * scheduled cron turns, then the configured background-task mode.
 */
export async function applyPrintBackgroundPolicy(
  input: PrintBackgroundPolicyInput,
): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    while ((await input.goalActive?.()) === true) {
      const ended = await input.turnEndings.next(
        Math.min(deadline - input.now(), GOAL_WAIT_POLL_MS),
        input.skipTurnId,
      );
      if (ended === null && input.now() >= deadline) {
        input.warn(`print goal wait ceiling reached (${input.ceilingS}s), finishing`);
        return;
      }
    }

    if (!cronWedged && input.cronNextFireAt !== undefined) {
      const fireAt = await input.cronNextFireAt();
      if (fireAt !== null) {
        if (fireAt <= input.now() && lastPastFireAt === fireAt) {
          cronWedged = true;
          input.warn(
            'print cron wait: next fire time stuck in the past; cron tick appears wedged, giving up on cron',
          );
        } else {
          if (fireAt <= input.now()) lastPastFireAt = fireAt;
          const ended = await input.turnEndings.next(
            Math.max(fireAt - input.now(), 0) + CRON_FIRE_GRACE_MS,
            input.skipTurnId,
          );
          if (ended !== null && ended.reason !== 'completed') {
            throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
          }
          continue;
        }
      }
    }

    if (input.mode === 'exit') return;
    if (input.mode === 'drain') {
      await input.drain();
      return;
    }

    turns += 1;
    if (input.now() >= deadline) {
      input.warn(`print steer ceiling reached (${input.ceilingS}s), finishing`);
      return;
    }
    if (turns > input.maxTurns) {
      input.warn(`print steer max turns reached (${input.maxTurns}), finishing`);
      return;
    }
    if ((await input.countPending()) === 0) return;
    const ended = await input.turnEndings.next(deadline - input.now(), input.skipTurnId);
    if (ended === null) return;
    if (ended.reason !== 'completed') {
      throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
    }
  }
}

function formatTurnEndingFailure(ending: PrintTurnEnding): string {
  const error =
    typeof ending.error === 'object' && ending.error !== null
      ? (ending.error as { readonly code?: string; readonly message?: string })
      : undefined;
  if (error?.code === 'provider.filtered') {
    return 'Provider safety policy blocked the response.';
  }
  if (error?.code !== undefined) return `${error.code}: ${error.message ?? ''}`.trimEnd();
  if (ending.reason === 'blocked') return 'Prompt hook blocked the request.';
  return `Prompt turn ended with reason: ${ending.reason}`;
}
