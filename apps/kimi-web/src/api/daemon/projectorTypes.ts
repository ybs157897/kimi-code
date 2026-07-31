// apps/kimi-web/src/api/daemon/projectorTypes.ts
// Public contract types of the agent event projector.

import type { AppEvent, AppInFlightTurn } from '../types';

// ---------------------------------------------------------------------------
// AgentProjector
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  /**
   * Wire-level pre-append stream offset on volatile text-delta frames (v2
   * sync protocol). Used to skip duplicate deltas and detect gaps after a
   * snapshot seed.
   */
  offset?: number;
}

export interface AgentProjector {
  /** Project a single raw agent-core event into zero or more AppEvents. Never throws. */
  project(rawType: string, payload: unknown, sessionId: string, meta?: ProjectMeta): AppEvent[];
  /**
   * Bind an externally-known promptId to the next turn.startd for this session.
   * Call this right after submitPrompt() returns, before the first turn.started arrives.
   */
  bindNextPromptId(sessionId: string, promptId: string): void;
  /**
   * Seed mid-turn state from a session snapshot's `in_flight_turn` (v2 sync):
   * resets per-session state, builds the partially-streamed assistant message
   * (thinking + text + running tool_use parts — the current step only; earlier
   * steps arrive via the transcript), and returns the messageCreated AppEvent
   * to apply to the reducer. Live deltas continue appending; their wire
   * `offset` aligns against the seeded text so the overlap window around
   * snapshot/subscribe is exact. Session status is NOT seeded here — the REST
   * snapshot's `session.status` is the authoritative value.
   */
  seedInFlight(sessionId: string, turn: AppInFlightTurn): AppEvent[];
  /** Reset all per-session state (call on re-subscribe / resync). */
  reset(sessionId: string): void;
  /**
   * Mark an agent id as a side-channel (e.g. BTW side chat) rather than a
   * background subagent. Its text/thinking deltas and turn boundary are then
   * emitted as agent-scoped events instead of being dropped.
   */
  markSideChannelAgent(agentId: string): void;
}
