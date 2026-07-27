import type { AgentEventsPort } from './agent-events-port';
import {
  getLegacySessionEventsBroker,
  type LegacySessionEventsSource,
} from './legacy-session-events-adapter';

/** Bind one legacy Session child to an agent-scoped TUI event port. */
export function createLegacyAgentEventsPort(
  session: LegacySessionEventsSource,
  agentId = 'main',
): AgentEventsPort {
  const broker = getLegacySessionEventsBroker(session);
  return {
    sessionId: session.id,
    agentId,
    subscribe: (listener) => broker.subscribeAgent(agentId, listener),
    readReplay: () => broker.readReplay(agentId),
  };
}

/**
 * Bind the interactive legacy agent chain. Live events include descendants so
 * the TUI can render child-agent progress, while replay remains rooted at the
 * interactive agent.
 */
export function createLegacySessionAgentEventsPort(
  session: LegacySessionEventsSource,
  agentId = 'main',
): AgentEventsPort {
  const broker = getLegacySessionEventsBroker(session);
  return {
    sessionId: session.id,
    agentId,
    subscribe: (listener) => broker.subscribeAllAgents(listener),
    readReplay: () => broker.readReplay(agentId),
  };
}
