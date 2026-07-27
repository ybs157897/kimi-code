import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionContextControlPort } from './session-context-control-port';

interface LegacySessionContextControlSession {
  compact(
    input?: Parameters<Session['compact']>[0],
  ): ReturnType<Session['compact']>;
  cancelCompaction(): ReturnType<Session['cancelCompaction']>;
  undoHistory(
    count?: Parameters<Session['undoHistory']>[0],
  ): ReturnType<Session['undoHistory']>;
}

/** Bridge one active legacy Session into the TUI context-control port. */
export function createLegacySessionContextControlPort(
  session: LegacySessionContextControlSession,
): SessionContextControlPort {
  return {
    compact: async (input) => {
      await session.compact(input);
      return true;
    },
    cancelCompaction: async () => {
      await session.cancelCompaction();
    },
    undoHistory: async (count = 1) => {
      await session.undoHistory(count);
    },
  };
}
