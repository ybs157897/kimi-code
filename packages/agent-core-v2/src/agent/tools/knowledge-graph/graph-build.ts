/**
 * `tools` domain (L7) — `IGraphBuildTool` contract (the `GraphBuild` tool).
 *
 * Runs the tree-sitter static extraction over the session workspace via the
 * `knowledgeGraph` domain service and persists the knowledge graph under the
 * project-config dir. Purely static analysis — no LLM tokens are consumed.
 * Bound at Agent scope; gated behind the `knowledge-graph` experimental flag.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const GRAPH_BUILD_TOOL_NAME = 'GraphBuild';

export interface GraphBuildInput {
  extraIgnorePatterns?: string[];
  maxFiles?: number;
}

export const GraphBuildInputSchema: z.ZodType<GraphBuildInput> = z.object({
  extraIgnorePatterns: z
    .array(z.string())
    .optional()
    .describe(
      'Additional gitignore-style patterns to exclude from analysis (e.g. ["fixtures/", "*.generated.ts"]).',
    ),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap on analyzed files (largest files are dropped first). Defaults to 5000.'),
});

export interface IGraphBuildTool extends AgentTool<GraphBuildInput> {
  readonly _serviceBrand: undefined;
}
export const IGraphBuildTool = createDecorator<IGraphBuildTool>('graphBuildTool');
