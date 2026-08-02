/**
 * `tools` domain (L7) — `GraphSummarizeTool` implementation (the `GraphSummarize` tool).
 *
 * Delegates to the Session-scope `IKnowledgeGraphService` (`knowledgeGraph`
 * domain). Three modes: list pending batches (no args), merge file analyses
 * (`analyses`), merge the project summary (`projectSummary`). Registered via
 * the module-level `registerAgentToolService`; activation is gated on the
 * `knowledge-graph` experimental flag. Bound at Agent scope.
 */

import { IFlagService } from '#/app/flag/flag';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { KNOWLEDGE_GRAPH_FLAG_ID } from '#/session/knowledgeGraph/flag';
import {
  IKnowledgeGraphService,
  type SummarizationStatus,
  type UnsummarizedFile,
} from '#/session/knowledgeGraph/knowledgeGraph';

import {
  GRAPH_SUMMARIZE_TOOL_NAME,
  GraphSummarizeInputSchema,
  IGraphSummarizeTool,
  type GraphSummarizeInput,
} from './graph-summarize';
import DESCRIPTION from './graph-summarize.md?raw';

const NO_GRAPH_MESSAGE =
  'No knowledge graph exists for this workspace yet. Call GraphBuild first, then run the summarization pass.';

function renderProgress(status: SummarizationStatus): string {
  const project = status.hasProjectSummary ? ', project summary done' : '';
  return `Progress: ${status.summarizedFiles}/${status.totalFiles} files summarized${project}.`;
}

function renderBatch(files: readonly UnsummarizedFile[]): string {
  const lines = files.map((file) => {
    const parts: string[] = [];
    if (file.functions.length > 0) parts.push(`functions: ${file.functions.join(', ')}`);
    if (file.classes.length > 0) parts.push(`classes: ${file.classes.join(', ')}`);
    return `- ${file.filePath}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`;
  });
  return [
    'Files waiting for summaries:',
    ...lines,
    '',
    'For each file: Read it, then produce one analyses entry shaped as',
    '{ "filePath": <path>, "fileSummary": <1-2 sentences>, "tags": [...], "complexity": "simple|moderate|complex", "functionSummaries": { <name>: <1 sentence> }, "classSummaries": { <name>: <1 sentence> } }.',
    'Summaries may be written in the user\u2019s language. When the batch is done, call GraphSummarize again with the analyses array.',
  ].join('\n');
}

export class GraphSummarizeTool implements IGraphSummarizeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = GRAPH_SUMMARIZE_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GraphSummarizeInputSchema);

  constructor(@IKnowledgeGraphService private readonly knowledgeGraph: IKnowledgeGraphService) {}

  resolveExecution(args: GraphSummarizeInput): ToolExecution {
    const mode = args.projectSummary ? 'project summary' : args.analyses ? 'merge analyses' : 'list batch';
    return {
      description: `Knowledge graph summarization: ${mode}`,
      approvalRule: this.name,
      execute: async () => {
        if (args.projectSummary) {
          await this.knowledgeGraph.applyProjectSummary(args.projectSummary);
          const status = await this.knowledgeGraph.summarizationStatus();
          return {
            isError: false,
            output: `Project summary merged. ${renderProgress(status)}`,
          };
        }

        if (args.analyses) {
          const { applied } = await this.knowledgeGraph.applyFileAnalyses(args.analyses);
          const status = await this.knowledgeGraph.summarizationStatus();
          const skipped = args.analyses.length - applied;
          return {
            isError: false,
            output: `Merged ${applied} file analyses${skipped > 0 ? ` (${skipped} skipped — not in graph)` : ''}. ${renderProgress(status)}`,
          };
        }

        const status = await this.knowledgeGraph.summarizationStatus();
        if (status.totalFiles === 0) {
          return { isError: false, output: NO_GRAPH_MESSAGE };
        }
        const remaining = status.totalFiles - status.summarizedFiles;
        if (remaining === 0) {
          return {
            isError: false,
            output: `${renderProgress(status)} All files summarized${
              status.hasProjectSummary
                ? '.'
                : ' — finish by merging a projectSummary (description, frameworks, layers).'
            }`,
          };
        }

        const batch = await this.knowledgeGraph.listUnsummarizedFiles({
          limit: args.batchSize ?? 10,
        });
        return {
          isError: false,
          output: `${renderProgress(status)}\n\n${renderBatch(batch)}`,
        };
      },
    };
  }
}

registerAgentToolService(IGraphSummarizeTool, GraphSummarizeTool, {
  name: GRAPH_SUMMARIZE_TOOL_NAME,
  domain: 'knowledgeGraph',
  when: (accessor) => accessor.get(IFlagService).enabled(KNOWLEDGE_GRAPH_FLAG_ID),
});
