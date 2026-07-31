/**
 * Delivery filtering for the session event broadcaster: the per-subscription
 * agent allowlist and the per-connection transcript dedup check, shared by
 * live fan-out and cursor replay (`sessionEventBroadcaster.ts`).
 */

import { gradeFor, type TranscriptGradeSpec } from '@moonshot-ai/transcript';
import type { AgentFilter } from './broadcasterTypes';
import type { EventEnvelope } from './sessionEventJournal';

/** Session/workspace/config events are broadcast to every connection. */
export function isGlobalEvent(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.')
  );
}

function isAgentLifecycleEvent(type: string): boolean {
  return type === 'agent.created' || type === 'agent.disposed';
}

/**
 * Per-subscription agent allowlist check — shared by live fan-out and replay.
 * Returns `true` when the envelope should be delivered to a subscriber carrying
 * `filter`:
 *   - `filter === undefined` → receive every agent (legacy session-grained
 *     behavior);
 *   - global events (session/workspace/config) and agent lifecycle events
 *     (`agent.created` / `agent.disposed`) are not per-agent stream content
 *     and always pass;
 *   - events without a string `agentId` (should not happen on the v1 wire,
 *     where the broadcaster stamps every event) pass defensively rather than
 *     being dropped;
 *   - otherwise the envelope's `payload.agentId` must be in the allowlist.
 */
export function matchesAgentFilter(envelope: EventEnvelope, filter: AgentFilter): boolean {
  if (filter === undefined) return true;
  if (isGlobalEvent(envelope.type)) return true;
  if (isAgentLifecycleEvent(envelope.type)) return true;
  const payload = envelope.payload;
  const agentId =
    typeof payload === 'object' && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== 'string') return true;
  return filter.has(agentId);
}

/**
 * Event types the transcript protocol already projects (the authoritative
 * mapping is the projector — `services/transcript/coreEventMap.ts`): a
 * connection carrying a non-'off' transcript grade for the emitting agent
 * gets the same information via `transcript.ops` / `transcript.reset`, so the
 * duplicate `session_event` is suppressed on that connection.
 *
 * Deliberately retained (never suppressed):
 *   - `agent.created` / `agent.disposed` — the transcript has no lifecycle
 *     events; a roster change surfaces there only implicitly, as the new
 *     agent's baseline reset;
 *   - `tool.list.updated`, `mcp.server.status` — not projected;
 *   - every global event ({@link isGlobalEvent}) — session/workspace/config
 *     facts live outside the per-agent transcript.
 *
 * Two entries are defensive: `prompt.submitted` is projected but nobody
 * publishes it on the v2 bus today (Phase 2 finding), and `task.notified` has
 * a projector case without a v1 wire-schema entry. `background.task.started`
 * / `background.task.terminated` are the legacy aliases of the projected
 * `task.started` / `task.terminated` (see {@link legacyTaskEvent}).
 */
const TRANSCRIPT_PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.interrupted',
  'turn.step.retrying',
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.call.started',
  'tool.progress',
  'tool.result',
  'shell.started',
  'shell.output',
  'shell.completed',
  'task.started',
  'task.terminated',
  'background.task.started',
  'background.task.terminated',
  'task.notified',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'skill.activated',
  'plugin_command.activated',
  'cron.fired',
  'error',
  'warning',
  'goal.updated',
  'plan.revision',
  'context.spliced',
  'agent.status.updated',
  'hook.result',
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'event.question.requested',
  'event.question.dismissed',
  'event.question.answered',
  'event.approval.requested',
  'event.approval.resolved',
]);

/**
 * Per-connection transcript dedup check — shared by live fan-out and replay,
 * mirroring {@link matchesAgentFilter}. Returns `true` when the envelope is a
 * transcript-projected `session_event` the subscriber already receives via
 * the transcript stream:
 *   - `spec === undefined` → nothing is suppressed (legacy connections see
 *     every `session_event`);
 *   - global events and agent lifecycle events are never suppressed;
 *   - events without a string `agentId` pass defensively (same rule as the
 *     agent allowlist);
 *   - an 'off' grade for the emitting agent suppresses nothing;
 *   - otherwise the envelope is suppressed iff its type is in
 *     {@link TRANSCRIPT_PROJECTED_EVENT_TYPES}.
 */
export function suppressedByTranscript(
  envelope: EventEnvelope,
  spec: TranscriptGradeSpec | undefined,
): boolean {
  if (spec === undefined) return false;
  if (isGlobalEvent(envelope.type)) return false;
  if (isAgentLifecycleEvent(envelope.type)) return false;
  const payload = envelope.payload;
  const agentId =
    typeof payload === 'object' && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== 'string') return false;
  if (gradeFor(spec, agentId) === 'off') return false;
  return TRANSCRIPT_PROJECTED_EVENT_TYPES.has(envelope.type);
}
