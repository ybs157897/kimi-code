/**
 * `tools` domain (L7) — `IGraphSummarizeTool` contract (the `GraphSummarize` tool).
 *
 * Drives the optional LLM summarization pass over an existing knowledge
 * graph: called without arguments it returns the next batch of files waiting
 * for summaries; called with `analyses` / `projectSummary` it merges the
 * agent-produced JSON back onto the graph. The tool itself never calls an
 * LLM — the summarization loop is orchestrated by the agent (skill-guided,
 * subagent-parallel). Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const GRAPH_SUMMARIZE_TOOL_NAME = 'GraphSummarize';

const FileAnalysisSchema = z.object({
  filePath: z.string().min(1),
  fileSummary: z.string().min(1).describe('1-2 sentence summary of what the file does.'),
  tags: z.array(z.string()).optional(),
  complexity: z.enum(['simple', 'moderate', 'complex']).optional(),
  functionSummaries: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map of function name -> 1-sentence summary.'),
  classSummaries: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map of class name -> 1-sentence summary.'),
});

const ProjectSummarySchema = z.object({
  description: z.string().min(1).describe('2-3 sentence description of the project.'),
  frameworks: z.array(z.string()).optional(),
  layers: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        filePatterns: z.array(z.string()).describe('Path prefixes or glob patterns in this layer.'),
      }),
    )
    .optional(),
});

export interface GraphSummarizeInput {
  batchSize?: number;
  analyses?: Array<z.infer<typeof FileAnalysisSchema>>;
  projectSummary?: z.infer<typeof ProjectSummarySchema>;
}

export const GraphSummarizeInputSchema: z.ZodType<GraphSummarizeInput> = z.object({
  batchSize: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Files per batch when listing pending work (default 10, max 50).'),
  analyses: z
    .array(FileAnalysisSchema)
    .optional()
    .describe('Completed file analyses to merge onto the graph.'),
  projectSummary: ProjectSummarySchema.optional().describe(
    'Project-level summary to merge (run once per project, after file batches).',
  ),
});

export interface IGraphSummarizeTool extends AgentTool<GraphSummarizeInput> {
  readonly _serviceBrand: undefined;
}
export const IGraphSummarizeTool = createDecorator<IGraphSummarizeTool>('graphSummarizeTool');
