/**
 * `tools` domain (L7) — `GraphBuildTool` implementation (the `GraphBuild` tool).
 *
 * Delegates to the Session-scope `IKnowledgeGraphService` (`knowledgeGraph`
 * domain). Registered via the module-level `registerAgentToolService` at the
 * bottom of this file. Bound at Agent scope.
 */

import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import {
  IKnowledgeGraphService,
  type KnowledgeGraphBuildProgress,
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
    'Knowledge graph build completed successfully.',
    `- files analyzed: ${stats.files}`,
    `- functions: ${stats.functions}`,
    `- classes: ${stats.classes}`,
    `- edges: ${stats.edges}`,
    `- took: ${stats.durationMs} ms`,
    stats.reusedFiles === undefined ? undefined : `- reused summaries: ${stats.reusedFiles}`,
    '',
    'Use GraphSearch to find files, functions, and classes by name or meaning.',
  ].filter((line): line is string => line !== undefined).join('\n');
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
      execute: async ({ onUpdate }) => {
        try {
          const stats = await this.knowledgeGraph.buildStatic({
            extraIgnorePatterns: args.extraIgnorePatterns,
            maxFiles: args.maxFiles,
            onProgress: (progress) => onUpdate?.(renderProgress(progress)),
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

function renderProgress(progress: KnowledgeGraphBuildProgress) {
  const phase =
    progress.phase === 'collecting'
      ? 'Collecting source files'
      : progress.phase === 'parsing'
        ? 'Parsing source files'
        : 'Saving knowledge graph';
  const count = `${progress.processedFiles}/${progress.totalFiles}`;
  return {
    kind: 'progress' as const,
    text: `${phase} (${count})`,
    percent:
      progress.totalFiles > 0
        ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
        : undefined,
  };
}

registerAgentToolService(IGraphBuildTool, GraphBuildTool, {
  name: GRAPH_BUILD_TOOL_NAME,
  domain: 'knowledgeGraph',
});
