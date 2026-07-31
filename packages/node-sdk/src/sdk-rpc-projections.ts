import type {
  AgentEventPayloads,
  AgentTaskInfo,
  KlientEventPayloads,
  SessionEventPayloads,
} from '@moonshot-ai/klient';
import type { MessageContent } from '@moonshot-ai/protocol';

import type { Event } from '#/events';
import type {
  ForwardedAgentEventName,
  V2CronTask,
  V2ExpertTeamMemberStatus,
  V2ExpertTeamSnapshot,
} from '#/sdk-rpc-types';
import type {
  BackgroundTaskInfo,
  ExpertTeamStatusSnapshot,
  GetCronTasksResult,
} from '#/types';

export function projectExpertTeamStatus(
  snapshot: V2ExpertTeamSnapshot | null,
): ExpertTeamStatusSnapshot | null {
  if (snapshot === null) return null;
  return {
    members: (snapshot.team?.members ?? []).map((member) => ({
      agentId: member.agentId,
      phase: {
        phase: projectExpertTeamStatusPhase(member.status),
        stepDescription: member.name,
      },
    })),
  };
}

export async function projectCronTasks(
  tasks: readonly V2CronTask[],
  getNextFireForTask: (taskId: string) => Promise<number | null>,
): Promise<GetCronTasksResult> {
  return {
    tasks: await Promise.all(
      tasks.map(async (task) => {
        const nextRunAt = await getNextFireForTask(task.id);
        return {
          id: task.id,
          name: task.id,
          expression: task.cron,
          status: nextRunAt === null ? 'inactive' : 'scheduled',
          nextRunAt: nextRunAt ?? undefined,
        };
      }),
    ),
  };
}

function projectExpertTeamStatusPhase(
  status: V2ExpertTeamMemberStatus,
): 'waiting' | 'active' | 'completed' {
  switch (status) {
    case 'spawning':
      return 'waiting';
    case 'running':
      return 'active';
    case 'completed':
    case 'failed':
    case 'shutdown':
      return 'completed';
  }
}

export function projectBackgroundTask(task: AgentTaskInfo): BackgroundTaskInfo {
  return {
    id: task.taskId,
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    description: task.description,
    command: task.kind === 'process' ? task.command : undefined,
    subagentType: task.kind === 'agent' ? task.subagentType : undefined,
    stopReason: task.stopReason,
    agentId: task.kind === 'agent' ? task.agentId : undefined,
    exitCode:
      task.kind === 'process' && task.exitCode !== null
        ? task.exitCode
        : undefined,
  };
}

export function projectAgentEventPayload(
  payload: AgentEventPayloads[ForwardedAgentEventName],
): object {
  if (!isPromptSteeredEvent(payload)) return payload;
  return {
    ...payload,
    content: payload.content.map(projectSteeredContentPart),
  };
}

function isPromptSteeredEvent(
  payload: AgentEventPayloads[ForwardedAgentEventName],
): payload is AgentEventPayloads['prompt.steered'] {
  return payload.type === 'prompt.steered';
}

function projectSteeredContentPart(
  part: AgentEventPayloads['prompt.steered']['content'][number],
): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return {
        type: 'thinking',
        thinking: part.think,
        signature: part.encrypted,
      };
    case 'image_url':
      return {
        type: 'image',
        source: projectMediaSource(part.imageUrl.url),
      };
    case 'video_url':
      return {
        type: 'video',
        source: projectMediaSource(part.videoUrl.url),
      };
    case 'audio_url':
      return {
        type: 'text',
        text: `[audio:${part.audioUrl.url}]`,
      };
  }
}

function projectMediaSource(
  url: string,
): Extract<MessageContent, { readonly type: 'image' | 'video' }>['source'] {
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl === null) return { kind: 'url', url };
  return {
    kind: 'base64',
    media_type: dataUrl[1]!,
    data: dataUrl[2]!,
  };
}

export function projectExpertTeamChangedEvent(
  sessionId: string,
  snapshot: SessionEventPayloads['expert-team.changed'],
): Event {
  return {
    type: 'expert_team.updated',
    sessionId,
    agentId: 'main',
    status:
      snapshot === null
        ? null
        : {
            pluginId: snapshot.binding.pluginId,
            pluginVersion: snapshot.binding.pluginVersion,
            displayName: snapshot.binding.displayName,
            leadAgentName: snapshot.binding.leadAgentName,
            activatedAt: snapshot.binding.activatedAt,
            members:
              snapshot.team === undefined
                ? snapshot.binding.memberAgentNames.map((name) => ({
                    name,
                    status: 'not_started' as const,
                  }))
                : snapshot.team.members.map((member) => ({
                    name: member.name,
                    agentId: member.agentId,
                    status: projectExpertTeamMemberStatus(member.status),
                  })),
          },
  };
}

export function projectModelCatalogChangedEvent(
  payload: KlientEventPayloads['kosong.changed'],
): Event {
  return {
    type: 'event.model_catalog.changed',
    sessionId: '__global__',
    agentId: 'main',
    changed: payload.changed,
    unchanged: payload.unchanged,
    failed: payload.failed,
  };
}

function projectExpertTeamMemberStatus(
  status: V2ExpertTeamMemberStatus,
): 'not_started' | 'idle' | 'running' {
  switch (status) {
    case 'spawning':
      return 'not_started';
    case 'running':
      return 'running';
    case 'completed':
    case 'failed':
    case 'shutdown':
      return 'idle';
  }
}
