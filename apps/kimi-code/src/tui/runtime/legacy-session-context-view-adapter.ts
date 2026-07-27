import {
  copyTUIContextMessage,
  type SessionContextView,
  type SessionContextViewPort,
} from './session-context-view-port';

interface LegacyContextViewHarness {
  withInteractiveAgent<T>(agentId: string, operation: () => T): T;
}

interface LegacyContextViewSession {
  getContext(): Promise<SessionContextView>;
}

/** Bind one legacy session and interactive agent to the read-only context view. */
export function createLegacySessionContextViewPort(
  harness: LegacyContextViewHarness,
  session: LegacyContextViewSession,
  agentId: string,
): SessionContextViewPort {
  return {
    read: async () => {
      const context = await harness.withInteractiveAgent(agentId, () =>
        session.getContext(),
      );
      return {
        history: context.history.map(copyTUIContextMessage),
        tokenCount: context.tokenCount,
      };
    },
  };
}
