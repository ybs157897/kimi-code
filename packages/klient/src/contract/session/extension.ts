/**
 * `sessionExtensionService` — code-extension command catalog and reload
 * contract.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const extensionCommandDefinitionSchema = z.object({
  extensionId: z.string(),
  name: z.string(),
  description: z.string(),
});

export const extensionLoadErrorSchema = z.object({
  path: z.string(),
  error: z.string(),
});

export const extensionReloadSummarySchema = z.object({
  active: z.array(z.string()),
  errors: z.array(extensionLoadErrorSchema),
});

export const sessionExtensionContract = {
  listCommands: {
    input: z.tuple([]),
    output: z.array(extensionCommandDefinitionSchema),
  },
  reload: {
    input: z.tuple([]),
    output: extensionReloadSummarySchema,
  },
} satisfies ServiceContract;
