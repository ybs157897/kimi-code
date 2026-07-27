import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionRefreshPort } from './session-refresh-port';

type Klient = KimiV2Runtime['klient'];

/**
 * Rebuild a v2 Session scope after refreshing process configuration.
 *
 * Closing and restoring preserves the session id while rematerializing its
 * scoped services with the latest config and feature flags.
 */
export function createKlientSessionRefreshPort(
  klient: Klient,
  sessionId: string,
): SessionRefreshPort {
  const session = klient.session(sessionId);
  return {
    reload: async () => {
      await klient.global.config.reload();
      await klient.global.plugins.reload();
      await session.close();
      if (!(await session.restore())) {
        throw new Error(`Session "${sessionId}" could not be restored after reload.`);
      }
    },
  };
}
