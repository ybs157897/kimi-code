import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRefreshPort } from './session-refresh-port';

interface LegacyRefreshSession {
  reloadSession(): ReturnType<Session['reloadSession']>;
}

/** Use the legacy engine's in-place session rebuild behind the neutral port. */
export function createLegacySessionRefreshPort(
  session: LegacyRefreshSession,
): SessionRefreshPort {
  return {
    reload: async () => {
      await session.reloadSession();
    },
  };
}
