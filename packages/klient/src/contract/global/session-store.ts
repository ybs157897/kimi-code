/**
 * `sessionStore` — App-scoped durable session fork operation.
 *
 * Mirrors `agent-core-v2/app/sessionStore/sessionSnapshotStore.ts`.
 * The `fork` method supports both full fork (no turnIndex) and turn-index fork
 * (with `userVisibleTurnIndex`). Physical delete remains an internal Store
 * operation and is exposed publicly only through `sessionLifecycleService`, so
 * a live Session scope cannot be bypassed.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const forkSnapshotInputSchema = z.object({
  sourceWorkspaceId: z.string(),
  sourceSessionId: z.string(),
  targetWorkspaceId: z.string(),
  targetSessionId: z.string(),
  userVisibleTurnIndex: z.number().int().nonnegative().optional(),
});

export const forkSnapshotResultSchema = z.object({
  sourceMeta: z
    .object({
      title: z.string().optional(),
      isCustomTitle: z.boolean().optional(),
      lastPrompt: z.string().optional(),
      custom: z.record(z.string(), z.unknown()).optional(),
      forkedFrom: z.string().optional(),
      agents: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  agentIds: z.array(z.string()),
  cutoffTime: z.number().optional(),
  lastPrompt: z.string().optional(),
});

export const deleteSnapshotInputSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
});

export const sessionStoreContract = {
  fork: { input: z.tuple([forkSnapshotInputSchema]), output: forkSnapshotResultSchema },
} satisfies ServiceContract;
