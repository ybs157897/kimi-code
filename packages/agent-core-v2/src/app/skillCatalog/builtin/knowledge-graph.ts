/**
 * `skillCatalog` domain (L3) — builtin `knowledge-graph` skill definition.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KNOWLEDGE_GRAPH_BODY from './knowledge-graph.md?raw';

const PSEUDO_PATH = 'builtin://knowledge-graph';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/knowledge-graph.md',
  skillDirName: 'knowledge-graph',
  source: 'builtin',
  text: KNOWLEDGE_GRAPH_BODY,
});

export const KNOWLEDGE_GRAPH_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
