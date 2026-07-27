/**
 * `agentExtensionService` — Agent-scoped extension command activation
 * contract.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const activateExtensionCommandInputSchema = z.object({
  extensionId: z.string(),
  name: z.string(),
  args: z.string().optional(),
});

export const agentExtensionContract = {
  activateCommand: {
    input: z.tuple([activateExtensionCommandInputSchema]),
    output: z.boolean(),
  },
} satisfies ServiceContract;
