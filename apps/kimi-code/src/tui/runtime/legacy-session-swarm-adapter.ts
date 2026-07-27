import type {
  SessionSwarmPort,
  SessionSwarmTrigger,
} from './session-swarm-port';

interface LegacySwarmSession {
  getStatus(): Promise<{ readonly swarmMode?: boolean }>;
  setSwarmMode(
    enabled: boolean,
    trigger: SessionSwarmTrigger,
  ): Promise<void>;
}

interface LegacySwarmHarness {
  getSession(sessionId: string): LegacySwarmSession | undefined;
  withInteractiveAgent<T>(agentId: string, operation: () => T): T;
}

/** Bind one legacy session and interactive agent to the neutral swarm port. */
export function createLegacySessionSwarmPort(
  harness: LegacySwarmHarness,
  sessionId: string,
  agentId: string,
): SessionSwarmPort {
  const run = <T>(operation: (session: LegacySwarmSession) => T): T =>
    harness.withInteractiveAgent(agentId, () =>
      operation(requireSession(harness, sessionId)),
    );

  return {
    isActive: async () => (await run((session) => session.getStatus())).swarmMode ?? false,
    enter: async (trigger) => {
      await run((session) => session.setSwarmMode(true, trigger));
    },
    exit: async () => {
      await run((session) => session.setSwarmMode(false, 'manual'));
    },
  };
}

function requireSession(
  harness: LegacySwarmHarness,
  sessionId: string,
): LegacySwarmSession {
  const session = harness.getSession(sessionId);
  if (session === undefined) {
    throw new Error(`Session "${sessionId}" is not active.`);
  }
  return session;
}
