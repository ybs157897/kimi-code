import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionSkillsPort } from './session-skills-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientAgentFacade = ReturnType<KlientSessionFacade['agent']>;

interface KlientSkillsAgentFacade {
  readonly skills: {
    activate(
      input: Parameters<KlientAgentFacade['skills']['activate']>[0],
    ): ReturnType<KlientAgentFacade['skills']['activate']>;
  };
}

interface KlientSkillsSessionFacade {
  readonly skills: {
    list(): ReturnType<KlientSessionFacade['skills']['list']>;
    reload(): ReturnType<KlientSessionFacade['skills']['reload']>;
  };
  agent(agentId: string): KlientSkillsAgentFacade;
}

/** Bridge one Klient session and selected agent into the TUI skills port. */
export function createKlientSessionSkillsPort(
  session: KlientSkillsSessionFacade,
  agentId: string,
): SessionSkillsPort {
  return {
    list: async () =>
      (await session.skills.list()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source: skill.source,
        type: skill.type,
        disableModelInvocation: skill.disableModelInvocation,
        isSubSkill: skill.isSubSkill,
      })),
    reload: () => session.skills.reload(),
    activate: async (name, args) => {
      await session.agent(agentId).skills.activate({ name, args });
    },
  };
}
