import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionInitPort } from './session-init-port';

interface LegacySessionInitSession {
  init(): ReturnType<Session['init']>;
  cancel(): ReturnType<Session['cancel']>;
}

/** Bridge an active SDK Session into the runtime-neutral init port. */
export function createLegacySessionInitPort(
  session: LegacySessionInitSession,
): SessionInitPort {
  return {
    generateAgentsMd: () => session.init(),
    cancel: () => session.cancel(),
  };
}
