import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type {
  SessionExpertTeamDefinition,
  SessionExpertTeamMember,
  SessionExpertTeamPort,
  SessionExpertTeamSnapshot,
} from './session-expert-team-port';

type LegacyExpertTeamDefinition = Awaited<
  ReturnType<Session['listExpertTeams']>
>[number];
type LegacyExpertTeamSnapshot = Awaited<
  ReturnType<Session['activateExpertTeam']>
>;
type LegacyExpertTeamStatus = NonNullable<
  Awaited<ReturnType<Session['getExpertTeamStatus']>>
>;

interface LegacySessionExpertTeamSession {
  listExpertTeams(): ReturnType<Session['listExpertTeams']>;
  getExpertTeamStatus(): ReturnType<Session['getExpertTeamStatus']>;
  activateExpertTeam(
    pluginId: Parameters<Session['activateExpertTeam']>[0],
  ): ReturnType<Session['activateExpertTeam']>;
  deactivateExpertTeam(): ReturnType<Session['deactivateExpertTeam']>;
}

/** Bridge one active SDK Session into the runtime-neutral expert-team port. */
export function createLegacySessionExpertTeamPort(
  session: LegacySessionExpertTeamSession,
): SessionExpertTeamPort {
  return {
    list: async () =>
      (await session.listExpertTeams()).map(projectDefinition),
    get: async () => {
      const status = await session.getExpertTeamStatus();
      return status === null ? null : projectStatus(status);
    },
    activate: async (pluginId) =>
      projectSnapshot(await session.activateExpertTeam(pluginId)),
    deactivate: async () => {
      await session.deactivateExpertTeam();
    },
  };
}

function projectDefinition(
  definition: LegacyExpertTeamDefinition,
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

function projectSnapshot(
  snapshot: LegacyExpertTeamSnapshot,
): SessionExpertTeamSnapshot {
  return {
    pluginId: snapshot.pluginId,
    pluginVersion: snapshot.pluginVersion,
    displayName: snapshot.displayName,
    leadAgentName: snapshot.leadAgentName,
    activatedAt: snapshot.activatedAt,
    members: undefined,
  };
}

function projectStatus(
  status: LegacyExpertTeamStatus,
): SessionExpertTeamSnapshot {
  return {
    pluginId: status.pluginId,
    pluginVersion: status.pluginVersion,
    displayName: status.displayName,
    leadAgentName: status.leadAgentName,
    activatedAt: status.activatedAt,
    members: status.members.map(projectMember),
  };
}

function projectMember(
  member: LegacyExpertTeamStatus['members'][number],
): SessionExpertTeamMember {
  return {
    name: member.name,
    agentId: member.agentId,
    status: member.status,
  };
}
