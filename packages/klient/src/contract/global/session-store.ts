/**
 * `sessionStore` — App-scoped session fork and hard-delete operations.
 *
 * Mirrors `agent-core-v2/app/sessionStore/sessionSnapshotStore.ts`.
 * Consumed by `sessionLifecycleService` and directly for CORE-104 physical
 * delete.  The `fork` method supports both full fork (no turnIndex) and
 * turn-index fork (with `userVisibleTurnIndex`).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
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
});

export const deleteSnapshotInputSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
});

export const sessionStoreContract = {
  fork: { input: z.tuple([forkSnapshotInputSchema]), output: forkSnapshotResultSchema },
  delete: { input: z.tuple([deleteSnapshotInputSchema]), output: noResult },
} satisfies ServiceContract;
