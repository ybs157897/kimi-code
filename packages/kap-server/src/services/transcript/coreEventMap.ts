/**
 * Engine event → transcript operation boundary.
 *
 * This class is intentionally a small, explicit router. Engine-specific event
 * discrimination stays in kap-server; each projector owns only the
 * replace-on-upsert or streaming state for its transcript model. The
 * transcript package receives L2 operations and has no engine dependency.
 */

import type {
  DomainEvent,
  ExpertTeamSnapshot,
} from '@moonshot-ai/agent-core-v2';
import type { TranscriptOperation } from '@moonshot-ai/transcript';

import { AgentMetaProjector } from './projectors/agentMetaProjector';
import { projectExpertTeamChanged } from './projectors/expertTeamProjector';
import {
  InteractionProjector,
  type ProjectorInteraction,
} from './projectors/interactionProjector';
import { LiveMarkerProjector } from './projectors/liveMarkerProjector';
import {
  PromptProjector,
  type ProjectorPromptSubmittedEvent,
} from './projectors/promptProjector';
import { TaskProjector } from './projectors/taskProjector';
import {
  TurnToolProjector,
  type ProjectorLookups,
} from './projectors/turnToolProjector';

export type { ProjectorInteraction } from './projectors/interactionProjector';
export type { ProjectorPromptSubmittedEvent } from './projectors/promptProjector';
export type {
  ProjectorFrameLookup,
  ProjectorLookups,
  ProjectorStepOrdinalLookup,
  ProjectorToolFrameLookup,
  ToolFrameRecord,
} from './projectors/turnToolProjector';

export class AgentTranscriptProjector {
  private readonly markers = new LiveMarkerProjector();
  private readonly turnTool: TurnToolProjector;
  private readonly meta = new AgentMetaProjector(this.markers);
  private readonly prompts = new PromptProjector();
  private readonly tasks: TaskProjector;
  private readonly interactions: InteractionProjector;

  constructor(
    readonly agentId: string,
    lookups?: ProjectorLookups,
  ) {
    this.turnTool = new TurnToolProjector(agentId, lookups);
    this.tasks = new TaskProjector((toolCallId, ref) =>
      this.turnTool.linkAgentRef(toolCallId, ref),
    );
    this.interactions = new InteractionProjector(
      (toolCallId, interactionId) =>
        this.turnTool.linkApproval(toolCallId, interactionId),
    );
  }

  map(
    event: DomainEvent | ProjectorPromptSubmittedEvent,
  ): TranscriptOperation[] {
    switch (event.type) {
      case 'turn.started':
      case 'turn.ended':
      case 'turn.step.started':
      case 'turn.step.completed':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'assistant.delta':
      case 'thinking.delta':
      case 'tool.call.delta':
      case 'tool.progress':
      case 'tool.call.started':
      case 'tool.result':
      case 'task.notified':
        return this.turnTool.project(event);
      case 'task.started':
      case 'task.terminated':
      case 'shell.started':
      case 'shell.output':
      case 'shell.completed':
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.suspended':
        return this.tasks.project(event);
      case 'goal.updated':
      case 'agent.status.updated':
      case 'agent.activity.updated':
      case 'plan.revision':
        return this.meta.project(event);
      case 'prompt.submitted':
      case 'prompt.completed':
      case 'prompt.aborted':
      case 'prompt.steered':
        return this.prompts.project(event);
      case 'hook.result':
      case 'skill.activated':
      case 'plugin_command.activated':
      case 'cron.fired':
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'context.spliced':
      case 'error':
      case 'warning':
        return this.markers.project(event);
      case 'context.undone':
      case 'extension.notice':
      case 'mcp.server.status':
      case 'permission.approval.requested':
      case 'permission.approval.resolved':
      case 'tool.list.updated':
        // These facts are intentionally not part of the transcript contract.
        return [];
      default:
        return [];
    }
  }

  mapExpertTeamChanged(
    previous: ExpertTeamSnapshot | null,
    current: ExpertTeamSnapshot | null,
  ): TranscriptOperation[] {
    return projectExpertTeamChanged(previous, current, this.markers);
  }

  mapInteractionRequested(
    interaction: ProjectorInteraction,
  ): TranscriptOperation[] {
    return this.interactions.requested(interaction);
  }

  mapInteractionResolved(
    id: string,
    response: unknown,
  ): TranscriptOperation[] {
    return this.interactions.resolved(id, response);
  }
}
