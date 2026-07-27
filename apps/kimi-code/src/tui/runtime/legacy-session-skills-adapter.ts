import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionSkillsPort } from './session-skills-port';

interface LegacySessionSkillsSession {
  listSkills(): ReturnType<Session['listSkills']>;
  reloadSession(): Promise<unknown>;
  activateSkill(
    name: Parameters<Session['activateSkill']>[0],
    args: Parameters<Session['activateSkill']>[1],
  ): ReturnType<Session['activateSkill']>;
}

/** Bridge an active SDK Session into the runtime-neutral TUI skills port. */
export function createLegacySessionSkillsPort(
  session: LegacySessionSkillsSession,
): SessionSkillsPort {
  return {
    list: async () =>
      (await session.listSkills()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source: skill.source,
        type: skill.type,
        disableModelInvocation: skill.disableModelInvocation,
        isSubSkill: skill.isSubSkill,
      })),
    // The legacy SDK has no skill-only reload. Preserve its existing /reload
    // runtime semantics here; refreshing the UI remains the caller's job.
    reload: async () => {
      await session.reloadSession();
    },
    activate: async (name, args) => {
      await session.activateSkill(name, args);
    },
  };
}
