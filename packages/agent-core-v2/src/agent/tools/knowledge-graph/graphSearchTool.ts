/**
 * `tools` domain (L7) — `GraphSearchTool` implementation (the `GraphSearch` tool).
 *
 * Delegates to the Session-scope `IKnowledgeGraphService` (`knowledgeGraph`
 * domain). When no graph exists yet the tool answers with guidance to call
 * `GraphBuild` instead of an error, so the agent can self-recover. Registered
 * via the module-level `registerAgentToolService`. Bound at Agent scope.
 */

import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import {
  IKnowledgeGraphService,
  type KnowledgeGraphSearchHit,
} from '#/session/knowledgeGraph/knowledgeGraph';

import {
  GRAPH_SEARCH_TOOL_NAME,
  GraphSearchInputSchema,
  IGraphSearchTool,
  type GraphSearchInput,
} from './graph-search';
import DESCRIPTION from './graph-search.md?raw';

const NO_GRAPH_MESSAGE =
  'No knowledge graph exists for this workspace yet. Call GraphBuild once to build it (fast, static, no model tokens), then retry GraphSearch.';

function renderHits(hits: readonly KnowledgeGraphSearchHit[]): string {
  const lines = hits.map((hit) => {
    const location = hit.filePath
      ? `${hit.filePath}${hit.lineRange ? `:${hit.lineRange[0]}-${hit.lineRange[1]}` : ''}`
      : '(no file)';
    const summary = hit.summary ? ` — ${hit.summary}` : '';
    return `- [${hit.type}] ${hit.name} (${location})${summary}`;
  });
  return [
    ...lines,
    '',
    'Open the reported locations with Read/Grep for the actual code. If results look outdated, rebuild with GraphBuild.',
  ].join('\n');
}

export class GraphSearchTool implements IGraphSearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = GRAPH_SEARCH_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GraphSearchInputSchema);

  constructor(@IKnowledgeGraphService private readonly knowledgeGraph: IKnowledgeGraphService) {}

  resolveExecution(args: GraphSearchInput): ToolExecution {
    return {
      description: `Searching knowledge graph: ${args.query}`,
      approvalRule: this.name,
      execute: async () => {
        const hits = await this.knowledgeGraph.search(args.query, {
          limit: args.limit ?? 10,
          types: args.types,
        });
        if (hits.length === 0) {
          const status = await this.knowledgeGraph.getStatus();
          if (status.state === 'missing') {
            return { isError: false, output: NO_GRAPH_MESSAGE };
          }
          return {
            isError: false,
            output: `No knowledge graph nodes matched "${args.query}". Try a different query, or rebuild with GraphBuild if the graph may be outdated.`,
          };
        }
        return { isError: false, output: renderHits(hits) };
      },
    };
  }
}

registerAgentToolService(IGraphSearchTool, GraphSearchTool, {
  name: GRAPH_SEARCH_TOOL_NAME,
  domain: 'knowledgeGraph',
});
