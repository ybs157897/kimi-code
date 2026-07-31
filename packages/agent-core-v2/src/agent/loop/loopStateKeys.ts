/**
 * `loop` domain (L4) — agent-state keys for plain-data loop state.
 *
 * The plain-data loop state (`nextReservedTurnId`, `lastRequestTraceId`,
 * `disposing`) the loop service registers into `agentState`
 * (`IAgentStateService`) and reads/writes through it.
 */

import { defineState } from '#/_base/state/stateRegistry';

export const loopNextReservedTurnIdKey = defineState<number | undefined>(
  'loop.nextReservedTurnId',
  () => undefined as number | undefined,
);
export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  'loop.lastRequestTraceId',
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);
