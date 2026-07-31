/**
 * Agent-swarm member lifecycle helpers: creation, state clearing, terminal
 * phase timing, and snapshot summaries.
 */

import type {
  AgentSwarmMember,
  AgentSwarmPhase,
  AgentSwarmSnapshot,
  AgentSwarmSummary,
  ClearableMemberKey,
} from './types';

export function createMembers(count: number, phase: AgentSwarmPhase): AgentSwarmMember[] {
  return Array.from({ length: count }, (_item, index) => ({
    id: String(index + 1).padStart(3, '0'),
    phase,
    ticks: 0,
    itemText: '',
    latestModelText: '',
  }));
}

export function clearMemberState(member: AgentSwarmMember, ...keys: ClearableMemberKey[]): void {
  for (const key of keys) delete member[key];
}

export function isTerminalPhase(phase: AgentSwarmPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

export function terminalPhaseElapsedMs(member: AgentSwarmMember, nowMs: number): number {
  const startedAtMs = member.phase === 'completed'
    ? member.completedAtMs
    : member.phase === 'failed'
      ? member.failedAtMs
      : undefined;
  return startedAtMs === undefined ? 0 : Math.max(0, nowMs - startedAtMs);
}

export function summarizeSnapshots(snapshots: readonly AgentSwarmSnapshot[]): AgentSwarmSummary {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const snapshot of snapshots) {
    if (snapshot.phase === 'completed') completed += 1;
    if (snapshot.phase === 'failed') failed += 1;
    if (snapshot.phase === 'cancelled') cancelled += 1;
  }
  return {
    active: snapshots.length - completed - failed - cancelled,
    completed,
    failed,
    cancelled,
  };
}
