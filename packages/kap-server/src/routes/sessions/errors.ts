/**
 * Error-envelope helpers for the `/sessions` routes: the structured
 * validation envelope and the shared Error2 → wire-code mapping used by the
 * action / profile / children / status / goal / warnings handlers.
 */

import { ErrorCodes, isError2 } from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';

import { errEnvelope } from '../../envelope';
import { requestLog } from '../../lib/requestLog';

export function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

export function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.fork_active_turn':
      case ErrorCodes.SESSION_BUSY:
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'compaction.unable':
        reply.send(errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId, err.stack));
        return;
      case 'session.undo_unavailable':
        reply.send({
          code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
          msg: err.message,
          data: (err as { details?: unknown }).details ?? null,
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case ErrorCodes.GOAL_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.GOAL_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_STATUS_INVALID:
        reply.send(errEnvelope(ErrorCode.GOAL_STATUS_INVALID, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_RESUMABLE:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_RESUMABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
        reply.send(errEnvelope(ErrorCode.GOAL_OBJECTIVE_EMPTY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
        reply.send(
          errEnvelope(ErrorCode.GOAL_OBJECTIVE_TOO_LONG, err.message, requestId, err.stack),
        );
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  log?.error({ err }, 'session request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}
