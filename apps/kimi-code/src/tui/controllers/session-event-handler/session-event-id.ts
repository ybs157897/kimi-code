/**
 * Resolve the session id a session-scoped event belongs to.
 */

import type { TUISessionScopedEvent } from '#/tui/runtime/session-events-port';

export function sessionEventId(event: TUISessionScopedEvent): string {
  return event.type === 'interaction.requested' ? event.interaction.sessionId : event.sessionId;
}
