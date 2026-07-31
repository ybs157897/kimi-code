/**
 * Shared types for the agent-swarm progress panel: member state, snapshots,
 * result summaries, and the grid layout model.
 */

import type {
  AgentSwarmProgressEstimatorPhase,
} from '#/tui/components/messages/agent-swarm-progress-estimator';

export type AgentSwarmPhase = AgentSwarmProgressEstimatorPhase;

export type TotalStatus = 'working' | 'completed' | 'suspended' | 'failed' | 'aborted';
export type ClearableMemberKey =
  | 'completedAtMs'
  | 'completedText'
  | 'failedAtMs'
  | 'failureText'
  | 'cancelledLabelText'
  | 'cancelledLabelColor'
  | 'cancelledMarkColor'
  | 'cancelledBarColor'
  | 'suspendedReason';

export interface AgentSwarmMember {
  readonly id: string;
  agentId?: string;
  phase: AgentSwarmPhase;
  ticks: number;
  itemText: string;
  latestModelText: string;
  completedText?: string;
  failureText?: string;
  cancelledLabelText?: string;
  cancelledLabelColor?: string;
  cancelledMarkColor?: string;
  cancelledBarColor?: string;
  suspendedReason?: string;
  completedAtMs?: number;
  failedAtMs?: number;
}

export interface AgentSwarmSnapshot {
  readonly phase: AgentSwarmPhase;
  readonly ticks: number;
  readonly latestModelText: string;
  readonly phaseElapsedMs: number;
}

export interface AgentSwarmResultStatus {
  readonly index: number;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly completedText?: string;
  readonly failureText?: string;
}

export interface AgentSwarmResultSummary {
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  readonly parsed: boolean;
}

export interface AgentSwarmSummary {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface AgentSwarmGridLayoutInput {
  readonly width: number;
  readonly height: number;
  readonly count: number;
}

export interface AgentSwarmGridLayout {
  readonly renderText: boolean;
  readonly barCells: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly columnGap: number;
  readonly leftPadding: number;
}

export interface AgentSwarmProgressOptions {
  readonly description: string;
  readonly requestRender?: () => void;
  readonly availableGridHeight?: () => number | undefined;
}
