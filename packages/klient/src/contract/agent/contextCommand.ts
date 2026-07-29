/**
 * `agentContextCommandService` — Agent-scoped context mutation commands
 * (clear / import). Mirrors `agent-core-v2/agent/contextCommand/contextCommand.ts`.
 *
 * Guarded behind active-turn and compaction checks: busy agents throw coded
 * errors instead of implicitly cancelling. Import additionally validates
 * input, XML-escapes content, and checks context window limits.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const contextImportInputSchema = z.object({
  content: z.string(),
  source: z.string(),
});

export const agentContextCommandContract = {
  clear: { input: z.tuple([]), output: noResult },
  importContext: { input: z.tuple([contextImportInputSchema]), output: noResult },
} satisfies ServiceContract;
