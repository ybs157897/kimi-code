/**
 * `goal` domain (L4) — goal pause-reason derivation.
 *
 * Maps turn/continuation failures onto the user-facing pause reason strings
 * and normalizes the underlying error payloads.
 */

import { ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';

import {
  GOAL_MODEL_CONFIG_PAUSE_PREFIX,
  GOAL_PROVIDER_API_PAUSE_PREFIX,
  GOAL_PROVIDER_AUTH_PAUSE_PREFIX,
  GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX,
  GOAL_PROVIDER_FILTERED_PAUSE_REASON,
  GOAL_RATE_LIMIT_PAUSE_REASON,
  GOAL_RUNTIME_PAUSE_PREFIX,
  LLM_NOT_SET_MESSAGE,
} from './goalConstants';

export function goalFailurePauseReason(error: unknown): string {
  const payload = normalizeGoalErrorPayload(error);
  switch (payload.code) {
    case ErrorCodes.PROVIDER_RATE_LIMIT:
      return GOAL_RATE_LIMIT_PAUSE_REASON;
    case ErrorCodes.PROVIDER_CONNECTION_ERROR:
      return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, payload.message);
    case ErrorCodes.PROVIDER_AUTH_ERROR:
      return pauseReasonWithMessage(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, payload.message);
    case ErrorCodes.PROVIDER_FILTERED:
      return GOAL_PROVIDER_FILTERED_PAUSE_REASON;
    case ErrorCodes.PROVIDER_API_ERROR:
      return pauseReasonWithMessage(GOAL_PROVIDER_API_PAUSE_PREFIX, payload.message);
    case ErrorCodes.MODEL_NOT_CONFIGURED:
      return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, LLM_NOT_SET_MESSAGE);
    case ErrorCodes.MODEL_CONFIG_INVALID:
      return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, payload.message);
    default:
      return pauseReasonWithMessage(GOAL_RUNTIME_PAUSE_PREFIX, payload.message);
  }
}

export function normalizeGoalErrorPayload(error: unknown): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  if (payload.code === ErrorCodes.MODEL_NOT_CONFIGURED) {
    return { ...payload, message: LLM_NOT_SET_MESSAGE };
  }
  return payload;
}

export function pauseReasonWithMessage(prefix: string, message: string | undefined): string {
  const trimmed = message?.trim();
  return trimmed === undefined || trimmed.length === 0 ? prefix : `${prefix}: ${trimmed}`;
}
