/**
 * Core `IEventService` payload validation for the session event broadcaster
 * (`sessionEventBroadcaster.ts`): unwrap the v1-shaped payloads published on
 * the core event bus before they are re-stamped and dispatched as wire events.
 */

import type { SessionCreatedEvent, SessionMetaUpdatedEvent } from './events';

/**
 * Validate the `session.meta.updated` payload published on the core
 * `IEventService`. Both the first-prompt auto-title path
 * (`agent-core-v2`'s `applyPromptMetadataUpdate`) and the
 * `POST /sessions/{id}/profile` rename route wrap the v1 fields under
 * `payload` alongside `agentId`/`sessionId`; we unwrap the title/patch here
 * and re-attach `agentId`/`sessionId` at the edge.
 */
export function sessionMetaUpdatedPayload(
  payload: unknown,
): Pick<SessionMetaUpdatedEvent, 'title' | 'patch'> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<SessionMetaUpdatedEvent>;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const patch =
    typeof candidate.patch === 'object' &&
      candidate.patch !== null &&
      !Array.isArray(candidate.patch)
      ? candidate.patch
      : undefined;
  if (title === undefined && patch === undefined) return undefined;
  return { title, patch };
}

/** Recover the originating session id carried on the core payload. */
export function sessionMetaUpdatedSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Validate the `event.session.created` payload published on the core
 * `IEventService`. The create/fork/child routes publish
 * `{ agentId, sessionId, session }`; we unwrap the real session id and wire
 * session here and re-attach `agentId`/`sessionId` at the edge.
 */
export function sessionCreatedPayload(
  payload: unknown,
): { sessionId: string; session: SessionCreatedEvent['session'] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { sessionId?: unknown; session?: unknown };
  const sessionId =
    typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
      ? candidate.sessionId
      : undefined;
  const session =
    typeof candidate.session === 'object' &&
      candidate.session !== null &&
      !Array.isArray(candidate.session)
      ? (candidate.session as SessionCreatedEvent['session'])
      : undefined;
  if (sessionId === undefined || session === undefined) return undefined;
  return { sessionId, session };
}
