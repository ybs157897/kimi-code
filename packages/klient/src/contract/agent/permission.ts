/**
 * `agentPermissionModeService` — the agent's read-only permission-mode view.
 * Only the `mode` property is wire-exposed; mutations remain on the
 * `agentRPCService.setPermission` control plane.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { permissionModeSchema } from './rpc.js';

export const agentPermissionModeContract = {
  mode: { input: z.tuple([]), output: permissionModeSchema },
} satisfies ServiceContract;
