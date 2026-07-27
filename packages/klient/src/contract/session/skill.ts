/**
 * Session skill-catalog contract.
 *
 * The session owns the merged, ready-to-present catalog. Agent-side
 * activation remains on `agentRPCService`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  source: z.enum(['project', 'user', 'extra', 'builtin']),
  type: z.string().optional(),
  disableModelInvocation: z.boolean().optional(),
  isSubSkill: z.boolean().optional(),
});

export const sessionSkillCatalogContract = {
  listSkills: {
    input: z.tuple([]),
    output: z.array(skillSummarySchema),
  },
  reload: {
    input: z.tuple([]),
    output: noResult,
  },
} satisfies ServiceContract;
