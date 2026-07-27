/**
 * `/api/v1` code-extension REST wire schemas.
 *
 * Projects the Session command catalog, reload diagnostics, and Agent command
 * activation into stable snake_case HTTP payloads.
 */

import { z } from 'zod';

export const extensionSessionParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const extensionCommandSchema = z.object({
  extension_id: z.string(),
  name: z.string(),
  description: z.string(),
});

export const listExtensionCommandsResponseSchema = z.object({
  commands: z.array(extensionCommandSchema),
});

export const reloadExtensionsResponseSchema = z.object({
  active: z.array(z.string()),
  errors: z.array(
    z.object({
      path: z.string(),
      error: z.string(),
    }),
  ),
});

export const activateExtensionCommandRequestSchema = z.object({
  extension_id: z.string().min(1),
  name: z.string().min(1),
  args: z.string().optional(),
});

export const activateExtensionCommandResponseSchema = z.object({
  activated: z.boolean(),
});
