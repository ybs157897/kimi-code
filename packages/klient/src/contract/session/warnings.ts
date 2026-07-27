/**
 * Session startup-warning contract.
 *
 * The engine currently exposes the cached secondary-model validation result
 * as one optional warning. The public facade normalizes that implementation
 * detail to a warning list.
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const sessionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const sessionSecondaryModelWarningContract = {
  getSecondaryModelWarning: {
    input: z.tuple([]),
    output: maybe(sessionWarningSchema),
  },
} satisfies ServiceContract;
