import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionWarningsPort } from './session-warnings-port';

interface LegacySessionWarningsSession {
  getSessionWarnings(): ReturnType<Session['getSessionWarnings']>;
}

/** Bridge one active legacy Session into the runtime-neutral warnings port. */
export function createLegacySessionWarningsPort(
  session: LegacySessionWarningsSession,
): SessionWarningsPort {
  return {
    list: async () =>
      (await session.getSessionWarnings()).map((warning) => ({
        code: warning.code,
        message: warning.message,
        severity: warning.severity,
      })),
  };
}
