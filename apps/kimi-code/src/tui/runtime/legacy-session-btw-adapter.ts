import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionBtwPort } from './session-btw-port';

interface LegacySessionBtwSession {
  startBtw(): ReturnType<Session['startBtw']>;
}

/** Bridge one active SDK Session into the runtime-neutral BTW port. */
export function createLegacySessionBtwPort(
  session: LegacySessionBtwSession,
): SessionBtwPort {
  return {
    start: async () => {
      const agentId = await session.startBtw();
      return agentId;
    },
  };
}
