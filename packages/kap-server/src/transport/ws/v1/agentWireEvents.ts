/**
 * Agent event wire mapping for the session event broadcaster: the server-side
 * volatile-vs-durable gate for the agent path and the legacy v1
 * `background.task.*` alias (`sessionEventBroadcaster.ts`).
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type { Event } from './events';

/**
 * Server-side durability gate for the agent event path. Live events reach the
 * edge via the per-agent `IEventBus`; their volatile vs durable
 * classification is owned here rather than by the protocol's
 * `VOLATILE_EVENT_TYPES` / `isVolatileEventType` (still used by the global /
 * model path in `dispatchGlobal`, and by the shipped v1 server). Volatile set
 * per plan line 475.
 */
const VOLATILE_SIGNAL_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
] as const;

const volatileSignalTypeSet: ReadonlySet<string> = new Set(VOLATILE_SIGNAL_TYPES);

export function isVolatileSignal(type: string): boolean {
  return volatileSignalTypeSet.has(type);
}

/**
 * v1 wire compatibility: map a native v2 background-task lifecycle event to its
 * pre-v2 spelling, returning `undefined` for every other event. The pre-v2
 * engine emitted `background.task.started`/`background.task.terminated`; v2
 * emits `task.started`/`task.terminated`. The payload (`info`) is kept
 * byte-identical and `agentId`/`sessionId` are re-stamped so the alias flows
 * through the same dispatch / journal / agent-filter path as the native event.
 *
 * Exists so unchanged v1 consumers (kimi-code TUI / `kimi -p`, node-sdk) keep
 * working while v2-shaped consumers (kimi-web) keep the native event and ignore
 * the alias (registered as known, no handler). Remove once every consumer has
 * migrated to `task.*`.
 */
export function legacyTaskEvent(
  event: DomainEvent,
  agentId: string,
  sessionId: string,
): Event | undefined {
  if (event.type !== 'task.started' && event.type !== 'task.terminated') return undefined;
  const legacyType =
    event.type === 'task.started' ? 'background.task.started' : 'background.task.terminated';
  return { ...event, type: legacyType, agentId, sessionId } as unknown as Event;
}
