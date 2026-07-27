/**
 * Expert-team snapshot projection.
 *
 * The Session service reports previous/current snapshots. This pure adapter
 * derives the mode badge and lifecycle markers without reaching into engine
 * services or the transcript store.
 */

import type { ExpertTeamSnapshot } from '@moonshot-ai/agent-core-v2';
import type {
  ExpertTeamModeMeta,
  TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { LiveMarkerProjector } from './liveMarkerProjector';

export function projectExpertTeamChanged(
  previous: ExpertTeamSnapshot | null,
  current: ExpertTeamSnapshot | null,
  markers: LiveMarkerProjector,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [
    {
      op: 'meta.merge',
      meta: {
        modes: {
          expertTeam: current === null ? null : mapExpertTeamMode(current),
        },
      },
    },
  ];

  if (previous === null && current !== null) {
    ops.push(markers.marker('expert-team.activate', { snapshot: current }));
  }
  if (previous?.team === undefined && current?.team !== undefined) {
    ops.push(markers.marker('expert-team.create', { team: current.team }));
  }
  if (previous?.team !== undefined && current?.team === undefined) {
    ops.push(markers.marker('expert-team.delete', {}));
  }
  if (previous !== null && current === null) {
    ops.push(markers.marker('expert-team.deactivate', {}));
  }
  return ops;
}

function mapExpertTeamMode(snapshot: ExpertTeamSnapshot): ExpertTeamModeMeta {
  return {
    pluginId: snapshot.binding.pluginId,
    displayName: snapshot.binding.displayName,
    leadAgentName: snapshot.binding.leadAgentName,
    activatedAt: snapshot.binding.activatedAt,
    team:
      snapshot.team === undefined
        ? undefined
        : {
            id: snapshot.team.id,
            name: snapshot.team.name,
            description: snapshot.team.description,
            createdAt: snapshot.team.createdAt,
            members: snapshot.team.members.map((member) => ({
              name: member.name,
              agentId: member.agentId,
              taskId: member.taskId,
              status: member.status,
            })),
          },
  };
}
