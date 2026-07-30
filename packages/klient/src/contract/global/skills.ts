/**
 * `workspaceSkillCatalogService` — session-less workspace skill listing.
 * Mirrors `agent-core-v2/app/skillCatalog/workspaceSkillCatalog.ts`.
 */

import { z } from 'zod';

import { skillSummarySchema } from '../session/skill.js';
import type { ServiceContract } from '../types.js';

export const workspaceSkillCatalogContract = {
  list: {
    input: z.tuple([z.string()]),
    output: z.array(skillSummarySchema),
  },
} satisfies ServiceContract;
