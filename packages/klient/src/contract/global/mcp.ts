/**
 * Global MCP management contracts for the App scope:
 * - `mcpCatalogService` — user-level MCP server catalog CRUD (`mcp.json`)
 * - `mcpOAuthService` — JSON-safe OAuth flow management via `flowId`
 * - `mcpProbeService` — one-shot MCP server connectivity testing
 *
 * Mirrors `agent-core-v2/app/mcpCatalog/mcpCatalog.ts`,
 * `app/mcpOAuth/mcpOAuth.ts`, and `app/mcpProbe/mcpProbe.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';

export const mcpCatalogEntrySchema = z.object({
  name: z.string(),
  config: mcpServerConfigSchema,
  source: z.literal('user'),
});

export const mcpCatalogContract = {
  list: { input: z.tuple([]), output: z.array(mcpCatalogEntrySchema) },
  get: { input: z.tuple([z.string()]), output: mcpCatalogEntrySchema.nullable() },
  add: { input: z.tuple([z.string(), mcpServerConfigSchema]), output: mcpCatalogEntrySchema },
  update: { input: z.tuple([z.string(), mcpServerConfigSchema]), output: mcpCatalogEntrySchema },
  rename: { input: z.tuple([z.string(), z.string()]), output: mcpCatalogEntrySchema },
  remove: { input: z.tuple([z.string()]), output: noResult },
  reset: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;

export const mcpBeginAuthorizationFlowResultSchema = z.object({
  flowId: z.string(),
  authorizationUrl: z.string(),
});

export const mcpOAuthContract = {
  beginAuthorizationWithFlowId: {
    input: z.tuple([z.string(), z.string()]),
    output: mcpBeginAuthorizationFlowResultSchema,
  },
  completeAuthorization: {
    input: z.tuple([z.string(), z.object({ timeoutMs: z.number().optional() }).optional()]),
    output: noResult,
  },
  cancelAuthorization: { input: z.tuple([z.string()]), output: noResult },
  invalidate: {
    input: z.tuple([z.string(), z.string(), z.enum(['all', 'client', 'tokens', 'discovery']).optional()]),
    output: noResult,
  },
} satisfies ServiceContract;

export const mcpProbeResultSchema = z.object({
  serverName: z.string(),
  success: z.boolean(),
  toolCount: z.number(),
  error: z.string().optional(),
});

export const mcpProbeContract = {
  probe: { input: z.tuple([z.string(), mcpServerConfigSchema]), output: mcpProbeResultSchema },
} satisfies ServiceContract;
