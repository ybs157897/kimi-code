import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  SessionExpertTeamDefinition,
  SessionExpertTeamMember,
  SessionExpertTeamPort,
  SessionExpertTeamSnapshot,
} from './session-expert-team-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientExpertTeamDefinition = Awaited<
  ReturnType<KlientSessionFacade['expertTeam']['list']>
>[number];
type KlientExpertTeamSnapshot = NonNullable<
  Awaited<ReturnType<KlientSessionFacade['expertTeam']['get']>>
>;

interface KlientSessionExpertTeamFacade {
  readonly expertTeam: {
    list(): ReturnType<KlientSessionFacade['expertTeam']['list']>;
    get(): ReturnType<KlientSessionFacade['expertTeam']['get']>;
    activate(
      pluginId: Parameters<
        KlientSessionFacade['expertTeam']['activate']
      >[0],
    ): ReturnType<KlientSessionFacade['expertTeam']['activate']>;
    deactivate(): ReturnType<KlientSessionFacade['expertTeam']['deactivate']>;
  };
}

/** Bridge one Klient session scope into the neutral expert-team port. */
export function createKlientSessionExpertTeamPort(
  session: KlientSessionExpertTeamFacade,
): SessionExpertTeamPort {
  const expertTeam = session.expertTeam;
  return {
    list: async () => (await expertTeam.list()).map(projectDefinition),
    get: async () => {
      const snapshot = await expertTeam.get();
      return snapshot === null
        ? null
        : projectKlientExpertTeamSnapshot(snapshot);
    },
    activate: async (pluginId) =>
      projectKlientExpertTeamSnapshot(await expertTeam.activate(pluginId)),
    deactivate: async () => {
      await expertTeam.deactivate();
    },
  };
}

function projectDefinition(
  definition: KlientExpertTeamDefinition,
): SessionExpertTeamDefinition {
  return {
    pluginId: definition.pluginId,
    pluginVersion: definition.pluginVersion,
    displayName: definition.displayName,
    description: definition.description,
    leadAgentName: definition.leadAgentName,
    memberAgentNames: [...definition.memberAgentNames],
    quickPrompts: [...definition.quickPrompts],
  };
}

export function projectKlientExpertTeamSnapshot(
  snapshot: KlientExpertTeamSnapshot,
): SessionExpertTeamSnapshot {
  return {
    pluginId: snapshot.binding.pluginId,
    pluginVersion: snapshot.binding.pluginVersion,
    displayName: snapshot.binding.displayName,
    leadAgentName: snapshot.binding.leadAgentName,
    activatedAt: snapshot.binding.activatedAt,
    members: snapshot.team?.members.map(projectMember),
  };
}

function projectMember(
  member: NonNullable<KlientExpertTeamSnapshot['team']>['members'][number],
): SessionExpertTeamMember {
  return {
    name: member.name,
    agentId: member.agentId,
    status: member.status,
  };
}
