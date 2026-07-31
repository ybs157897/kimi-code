/**
 * `loop` domain (L4) — pure reason-label mapping for loop outcomes.
 *
 * Maps provider finish reasons onto loop-event labels and failed/cancelled
 * turn results onto telemetry interrupt reasons.
 */

import { isUserCancellation } from '#/_base/utils/abort';
import { type FinishReason } from '#/kosong/contract/provider';
import { ErrorCodes, isError2 } from '#/errors';
import type { TurnInterruptedEvent } from '#/app/telemetry/events';

import { isMaxStepsExceededError, type TurnResult } from './loop';

export function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

export function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptedEvent['interrupt_reason'] {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}
