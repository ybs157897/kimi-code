/**
 * Agent metadata and mode projection.
 *
 * This projector owns the only state needed by these events: whether plan
 * mode is currently active, which decides whether a plan revision refines the
 * visible badge. Marker ids remain owned by LiveMarkerProjector.
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type {
  AgentUsageMeta,
  TranscriptOperation,
} from '@moonshot-ai/transcript';

import { toLegacyPhase } from '../../legacyStatus/legacyStatus';
import {
  eventPayload,
  type LiveMarkerProjector,
} from './liveMarkerProjector';

type GoalUpdatedEvent = Extract<DomainEvent, { type: 'goal.updated' }>;
type AgentStatusUpdatedEvent = Extract<DomainEvent, { type: 'agent.status.updated' }>;
type AgentActivityUpdatedEvent = Extract<DomainEvent, { type: 'agent.activity.updated' }>;
type PlanRevisionEvent = Extract<DomainEvent, { type: 'plan.revision' }>;

export type AgentMetaProjectionEvent =
  | GoalUpdatedEvent
  | AgentStatusUpdatedEvent
  | AgentActivityUpdatedEvent
  | PlanRevisionEvent;

export class AgentMetaProjector {
  private planModeActive = false;

  constructor(private readonly markers: LiveMarkerProjector) {}

  project(event: AgentMetaProjectionEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'goal.updated':
        return this.onGoalUpdated(event);
      case 'agent.status.updated':
        return this.onStatusUpdated(event);
      case 'agent.activity.updated':
        return this.onActivityUpdated(event);
      case 'plan.revision':
        return this.onPlanRevision(event);
    }
  }

  private onGoalUpdated(event: GoalUpdatedEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const snapshot = event.snapshot;
    if (snapshot !== null) {
      ops.push({
        op: 'meta.merge',
        meta: {
          goal: {
            objective: snapshot.objective,
            status: snapshot.status,
            completionCriterion: snapshot.completionCriterion,
            budgetUsed: snapshot.tokensUsed,
            budgetLimit: snapshot.budget.tokenBudget ?? undefined,
          },
        },
      });
    }
    ops.push(this.markers.marker('goal', eventPayload(event)));
    return ops;
  }

  private onStatusUpdated(event: AgentStatusUpdatedEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const modes: {
      plan?: Record<string, never> | null;
      swarm?: Record<string, never> | null;
    } = {};
    if (event.planMode === true) {
      modes.plan = {};
      this.planModeActive = true;
    } else if (event.planMode === false) {
      modes.plan = null;
      this.planModeActive = false;
    }
    if (event.swarmMode === true) modes.swarm = {};
    else if (event.swarmMode === false) modes.swarm = null;
    if (modes.plan !== undefined || modes.swarm !== undefined) {
      ops.push({ op: 'meta.merge', meta: { modes } });
    }

    const eventWithWireSlices = event as AgentStatusUpdatedEvent & {
      contextUsage?: number;
      permission?: 'manual' | 'yolo' | 'auto';
    };
    const agent: {
      model?: string;
      thinkingEffort?: string;
      usage?: AgentUsageMeta;
      contextTokens?: number;
      maxContextTokens?: number;
      contextUsage?: number;
      permission?: 'manual' | 'yolo' | 'auto';
    } = {};
    let hasStatusSlice = false;
    if (event.model !== undefined) {
      agent.model = event.model;
      hasStatusSlice = true;
    }
    if (event.thinkingEffort !== undefined) {
      agent.thinkingEffort = event.thinkingEffort;
      hasStatusSlice = true;
    }
    if (event.usage !== undefined) {
      agent.usage = event.usage;
      hasStatusSlice = true;
    }
    if (event.contextTokens !== undefined) {
      agent.contextTokens = event.contextTokens;
      hasStatusSlice = true;
    }
    if (event.maxContextTokens !== undefined) {
      agent.maxContextTokens = event.maxContextTokens;
      hasStatusSlice = true;
    }
    if (eventWithWireSlices.contextUsage !== undefined) {
      agent.contextUsage = eventWithWireSlices.contextUsage;
      hasStatusSlice = true;
    }
    if (eventWithWireSlices.permission !== undefined) {
      agent.permission = eventWithWireSlices.permission;
      hasStatusSlice = true;
    }
    if (hasStatusSlice) {
      ops.push({ op: 'meta.merge', meta: { agent } });
    }
    return ops;
  }

  private onActivityUpdated(event: AgentActivityUpdatedEvent): TranscriptOperation[] {
    const phase = toLegacyPhase(event);
    return phase === undefined
      ? []
      : [{ op: 'meta.merge', meta: { agent: { phase } } }];
  }

  private onPlanRevision(event: PlanRevisionEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [
      this.markers.marker('plan.revision', eventPayload(event)),
    ];
    if (this.planModeActive) {
      ops.push({
        op: 'meta.merge',
        meta: {
          modes: {
            plan: {
              reviewPath: event.path,
              version: event.version,
            },
          },
        },
      });
    }
    return ops;
  }
}
