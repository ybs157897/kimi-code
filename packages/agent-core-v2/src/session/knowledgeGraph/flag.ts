/**
 * `knowledgeGraph` domain — knowledge-graph experimental flag registration.
 *
 * Off by default; `KIMI_CODE_EXPERIMENTAL_KNOWLEDGE_GRAPH=1` opts in. Importing
 * this module registers the flag with the App catalog.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const KNOWLEDGE_GRAPH_FLAG_ID = 'knowledge-graph';
export const KNOWLEDGE_GRAPH_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_KNOWLEDGE_GRAPH';

export const knowledgeGraphFlag: FlagDefinitionInput = {
  id: KNOWLEDGE_GRAPH_FLAG_ID,
  title: 'Knowledge graph',
  description:
    'Build a tree-sitter knowledge graph of the workspace codebase and let the agent search it on demand for architecture and code-location questions.',
  env: KNOWLEDGE_GRAPH_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(knowledgeGraphFlag);
