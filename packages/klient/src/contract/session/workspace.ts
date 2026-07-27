/**
 * Session workspace contracts — the read-only workspace-context properties
 * plus the additional-directory command. Context mutators and path-policy
 * helpers remain internal to the engine.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const addAdditionalDirInputSchema = z.object({
  path: z.string(),
  persist: z.boolean().optional(),
});

export const workspaceAdditionalDirsResultSchema = z.object({
  projectRoot: z.string(),
  configPath: z.string(),
  additionalDirs: z.array(z.string()),
  persisted: z.boolean(),
});

export const sessionWorkspaceContextContract = {
  workDir: { input: z.tuple([]), output: z.string() },
  additionalDirs: { input: z.tuple([]), output: z.array(z.string()) },
} satisfies ServiceContract;

export const sessionWorkspaceCommandContract = {
  addAdditionalDir: {
    input: z.tuple([addAdditionalDirInputSchema]),
    output: workspaceAdditionalDirsResultSchema,
  },
} satisfies ServiceContract;
