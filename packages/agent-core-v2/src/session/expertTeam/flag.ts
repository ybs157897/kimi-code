/**
 * `expertTeam` domain (L6) — expert-team experimental flag registration.
 *
 * On by default; `KIMI_CODE_EXPERIMENTAL_EXPERT_TEAMS=0` opts out. Importing
 * this module registers the flag with the App catalog.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';
import { EXPERT_TEAMS_FLAG_ID } from '#/app/plugin/types';

export const EXPERT_TEAMS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_EXPERT_TEAMS';

export const expertTeamsFlag: FlagDefinitionInput = {
  id: EXPERT_TEAMS_FLAG_ID,
  title: 'Expert teams',
  description:
    'Activate plugin-defined expert-team modes with a lead, declared specialists, shared progress, and explicit team messaging.',
  env: EXPERT_TEAMS_FLAG_ENV,
  default: true,
  surface: 'both',
};

registerFlagDefinition(expertTeamsFlag);
