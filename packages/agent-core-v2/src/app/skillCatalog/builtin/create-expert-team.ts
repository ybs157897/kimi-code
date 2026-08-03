/**
 * `skillCatalog` domain (L3) — builtin `create-expert-team` skill definition.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import CREATE_EXPERT_TEAM_BODY from './create-expert-team.md?raw';

const PSEUDO_PATH = 'builtin://create-expert-team';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/create-expert-team.md',
  skillDirName: 'create-expert-team',
  source: 'builtin',
  text: CREATE_EXPERT_TEAM_BODY,
});

export const CREATE_EXPERT_TEAM_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
