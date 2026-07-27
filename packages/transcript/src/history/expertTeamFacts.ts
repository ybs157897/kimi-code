/**
 * Pure cold-path projection for persisted expert-team facts.
 *
 * The input is structural so engine wire records are assignable without an
 * engine dependency. The caller owns marker ids and final snapshot assembly;
 * this reducer owns only expert-team read-model state.
 */

import type {
  ExpertTeamMemberStatus,
  ExpertTeamModeMeta,
} from '../model/meta';

export interface ExpertTeamHistoryRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ExpertTeamFactState {
  readonly mode?: ExpertTeamModeMeta;
  readonly touched: boolean;
}

export interface ExpertTeamFactProjection {
  readonly state: ExpertTeamFactState;
  readonly marker?: string;
}

const MEMBER_STATUSES = new Set<ExpertTeamMemberStatus>([
  'spawning',
  'running',
  'completed',
  'failed',
  'shutdown',
]);

export function reduceExpertTeamFact(
  state: ExpertTeamFactState,
  record: ExpertTeamHistoryRecord,
): ExpertTeamFactProjection | undefined {
  switch (record.type) {
    case 'expert_team.activate': {
      const mode = readMode(record['snapshot']);
      return mode === undefined
        ? undefined
        : {
            state: {
              mode,
              touched: true,
            },
            marker: 'expert-team.activate',
          };
    }
    case 'expert_team.deactivate':
      return {
        state: {
          mode: undefined,
          touched: true,
        },
        marker: 'expert-team.deactivate',
      };
    case 'expert_team.create': {
      if (state.mode === undefined) return undefined;
      const team = readTeam(record['team']);
      return team === undefined
        ? undefined
        : {
            state: {
              mode: {
                ...state.mode,
                team,
              },
              touched: true,
            },
            marker: 'expert-team.create',
          };
    }
    case 'expert_team.member_upsert': {
      if (state.mode?.team === undefined) return undefined;
      const member = readMember(record['member']);
      return member === undefined
        ? undefined
        : {
            state: {
              mode: {
                ...state.mode,
                team: {
                  ...state.mode.team,
                  members: [
                    ...state.mode.team.members.filter(
                      (candidate) => candidate.agentId !== member.agentId,
                    ),
                    member,
                  ],
                },
              },
              touched: true,
            },
          };
    }
    case 'expert_team.delete':
      return state.mode === undefined
        ? undefined
        : {
            state: {
              mode: {
                pluginId: state.mode.pluginId,
                displayName: state.mode.displayName,
                leadAgentName: state.mode.leadAgentName,
                activatedAt: state.mode.activatedAt,
              },
              touched: true,
            },
            marker: 'expert-team.delete',
          };
    default:
      return undefined;
  }
}

function readMember(
  raw: unknown,
): NonNullable<ExpertTeamModeMeta['team']>['members'][number] | undefined {
  const member = asRecord(raw);
  if (member === undefined) return undefined;
  const { name, agentId, status, taskId } = member;
  if (
    typeof name !== 'string' ||
    typeof agentId !== 'string' ||
    typeof status !== 'string' ||
    !MEMBER_STATUSES.has(status as ExpertTeamMemberStatus)
  ) {
    return undefined;
  }
  return {
    name,
    agentId,
    status: status as ExpertTeamMemberStatus,
    taskId: typeof taskId === 'string' ? taskId : undefined,
  };
}

function readTeam(
  raw: unknown,
): NonNullable<ExpertTeamModeMeta['team']> | undefined {
  const team = asRecord(raw);
  if (team === undefined) return undefined;
  const { id, name, description, createdAt, members } = team;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof createdAt !== 'string' ||
    !Array.isArray(members)
  ) {
    return undefined;
  }
  return {
    id,
    name,
    description: typeof description === 'string' ? description : undefined,
    createdAt,
    members: members.flatMap((member) => {
      const parsed = readMember(member);
      return parsed === undefined ? [] : [parsed];
    }),
  };
}

function readMode(raw: unknown): ExpertTeamModeMeta | undefined {
  const snapshot = asRecord(raw);
  const binding = asRecord(snapshot?.['binding']);
  if (binding === undefined) return undefined;
  const { pluginId, displayName, leadAgentName, activatedAt } = binding;
  if (
    typeof pluginId !== 'string' ||
    typeof displayName !== 'string' ||
    typeof leadAgentName !== 'string' ||
    typeof activatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    pluginId,
    displayName,
    leadAgentName,
    activatedAt,
    team: readTeam(snapshot?.['team']),
  };
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null
    ? (raw as Record<string, unknown>)
    : undefined;
}
