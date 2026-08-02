/**
 * `tools` domain (L7) — `IGraphSearchTool` contract (the `GraphSearch` tool).
 *
 * Fuzzy-searches the workspace knowledge graph (files, functions, classes)
 * and returns node locations so the agent can jump straight to the relevant
 * source with Read/Grep instead of scanning the tree. Read-only. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const GRAPH_SEARCH_TOOL_NAME = 'GraphSearch';

export interface GraphSearchInput {
  query: string;
  limit?: number;
  types?: Array<'file' | 'function' | 'class'>;
}

export const GraphSearchInputSchema: z.ZodType<GraphSearchInput> = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'What to look for — a symbol name ("SessionManager"), a concept ("auth login"), or a file fragment.',
    ),
  limit: z.number().int().positive().max(50).optional().describe('Max results (default 10).'),
  types: z
    .array(z.enum(['file', 'function', 'class']))
    .optional()
    .describe('Restrict node types. Omit to search all types.'),
});

export interface IGraphSearchTool extends AgentTool<GraphSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IGraphSearchTool = createDecorator<IGraphSearchTool>('graphSearchTool');
