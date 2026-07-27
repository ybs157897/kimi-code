/**
 * `agentSwarmService` contract — agent-scoped swarm-mode state and
 * transitions. This stays separate from the turn-driving Agent RPC surface.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const swarmModeTriggerSchema = z.enum(['manual', 'task', 'tool']);

export const agentSwarmContract = {
  isActive: { input: z.tuple([]), output: z.boolean() },
  enter: { input: z.tuple([swarmModeTriggerSchema]), output: noResult },
  exit: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;
