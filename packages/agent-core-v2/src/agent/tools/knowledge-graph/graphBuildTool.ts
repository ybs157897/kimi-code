/**
 * `tools` domain (L7) — `GraphBuildTool` implementation (the `GraphBuild` tool).
 *
 * Delegates to the Session-scope `IKnowledgeGraphService` (`knowledgeGraph`
 * domain). Registered via the module-level `registerAgentToolService` at the
 * bottom of this file; activation is gated on the `knowledge-graph`
 * experimental flag through the `when` predicate. Bound at Agent scope.
 */

import { IFlagService } from '#/app/flag/flag';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { KNOWLEDGE_GRAPH_FLAG_ID } from '#/session/knowledgeGraph/flag';
import {
  IKnowledgeGraphService,
  type KnowledgeGraphBuildStats,
} from '#/session/knowledgeGraph/knowledgeGraph';

import {
  GRAPH_BUILD_TOOL_NAME,
  GraphBuildInputSchema,
  IGraphBuildTool,
  type GraphBuildInput,
} from './graph-build';
import DESCRIPTION from './graph-build.md?raw';

function renderStats(stats: KnowledgeGraphBuildStats): string {
  return [
    'Knowledge graph built.',
    `- files analyzed: ${stats.files}`,
    `- functions: ${stats.functions}`,
    `- classes: ${stats.classes}`,
    `- edges: ${stats.edges}`,
    `- took: ${stats.durationMs} ms`,
    '',
    'Use GraphSearch to find files, functions, and classes by name or meaning.',
  ].join('\n');
}

export class GraphBuildTool implements IGraphBuildTool {
  declare readonly _serviceBrand: undefined;
  readonly name = GRAPH_BUILD_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GraphBuildInputSchema);

  constructor(@IKnowledgeGraphService private readonly knowledgeGraph: IKnowledgeGraphService) {}

  resolveExecution(args: GraphBuildInput): ToolExecution {
    return {
      description: 'Building workspace knowledge graph',
      approvalRule: this.name,
      execute: async () => {
        try {
          const stats = await this.knowledgeGraph.buildStatic({
            extraIgnorePatterns: args.extraIgnorePatterns,
            maxFiles: args.maxFiles,
          });
          return { isError: false, output: renderStats(stats) };
        } catch (error) {
          return {
            isError: true,
            output: `Failed to build the knowledge graph: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }
}

registerAgentToolService(IGraphBuildTool, GraphBuildTool, {
  name: GRAPH_BUILD_TOOL_NAME,
  domain: 'knowledgeGraph',
  when: (accessor) => accessor.get(IFlagService).enabled(KNOWLEDGE_GRAPH_FLAG_ID),
});
