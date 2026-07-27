/**
 * `sessionInitService` contract — generation and cancellation of the
 * session-level AGENTS.md initialization run.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const sessionInitContract = {
  generateAgentsMd: { input: z.tuple([]), output: noResult },
  cancelInit: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;
