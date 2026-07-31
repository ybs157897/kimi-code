/**
 * Status bar and total-status rendering for the agent-swarm panel footer.
 */

import chalk from 'chalk';

import { FAILURE_MARK, SUCCESS_MARK } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

import {
  ABORTED_LABEL,
  ACTIVITY_SPINNER_PLACEHOLDER,
  CANCELLED_MARK,
  COMPLETED_LABEL,
  FAILED_LABEL,
  STATUS_BAR_CHAR,
  STATUS_BAR_ORDER,
  SUSPENDED_LABEL,
  WORKING_LABEL,
} from './constants';
import type { StatusBarPhase } from './constants';
import type { AgentSwarmMember, AgentSwarmPhase, TotalStatus } from './types';

interface StatusBarCount {
  readonly phase: StatusBarPhase;
  readonly count: number;
}

export function renderStatusPipBar(
  members: readonly AgentSwarmMember[],
  width: number,
  colors: ColorPalette,
): string {
  const safeWidth = Math.max(1, width);
  const counts = statusBarCounts(members);
  if (counts.length === 0) {
    return chalk.hex(colors.textMuted)(STATUS_BAR_CHAR.repeat(safeWidth));
  }

  const segmentWidths = allocateSegmentWidths(counts.map((entry) => entry.count), safeWidth);
  return counts.map((entry, index) => {
    const segmentWidth = segmentWidths[index] ?? 0;
    if (segmentWidth <= 0) return '';
    return chalk.hex(statusBarColor(entry.phase, colors))(STATUS_BAR_CHAR.repeat(segmentWidth));
  }).join('');
}

export function renderStatusLabel(label: string, color: string): string {
  return ` ${chalk.hex(color)(label)}`;
}

export function activityPrefixForTotalStatus(status: TotalStatus, colors: ColorPalette): string {
  const marks: Record<TotalStatus, string> = {
    completed: SUCCESS_MARK.trimEnd(),
    failed: FAILURE_MARK.trimEnd(),
    aborted: CANCELLED_MARK.trimEnd(),
    working: '',
    suspended: '',
  };
  const mark = marks[status];
  return mark.length > 0
    ? ` ${chalk.hex(totalStatusColor(status, colors))(mark)}`
    : ACTIVITY_SPINNER_PLACEHOLDER;
}

export function statusBarCounts(members: readonly AgentSwarmMember[]): StatusBarCount[] {
  const counts = new Map<StatusBarPhase, number>();
  for (const member of members) {
    const phase = statusBarPhase(member.phase);
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return STATUS_BAR_ORDER.flatMap((phase) => {
    const count = counts.get(phase) ?? 0;
    return count > 0 ? [{ phase, count }] : [];
  });
}

export function statusBarPhase(phase: AgentSwarmPhase): StatusBarPhase {
  const map: Record<AgentSwarmPhase, StatusBarPhase> = {
    pending: 'queued',
    queued: 'queued',
    suspended: 'suspended',
    running: 'working',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  return map[phase];
}

export function statusBarColor(phase: StatusBarPhase, colors: ColorPalette): string {
  const map: Record<StatusBarPhase, string> = {
    queued: colors.textMuted,
    working: colors.primary,
    suspended: colors.textMuted,
    completed: colors.success,
    failed: colors.error,
    cancelled: colors.warning,
  };
  return map[phase];
}

export function totalStatus(
  members: readonly AgentSwarmMember[],
  force: { readonly failed: boolean; readonly aborted: boolean },
): TotalStatus {
  if (force.aborted) return 'aborted';
  const phases = new Set(members.map((m) => m.phase));
  const hasActive = phases.has('pending') || phases.has('queued') || phases.has('suspended') || phases.has('running');
  if (!hasActive && members.length > 0) {
    if (phases.has('cancelled')) return 'aborted';
    if (phases.has('completed')) return 'completed';
    return 'failed';
  }
  if (force.failed) return 'failed';
  if (phases.has('suspended') && !phases.has('running')) return 'suspended';
  return 'working';
}

export function totalStatusLabel(status: TotalStatus): string {
  const map: Record<TotalStatus, string> = {
    working: WORKING_LABEL,
    completed: COMPLETED_LABEL,
    suspended: SUSPENDED_LABEL,
    failed: FAILED_LABEL,
    aborted: ABORTED_LABEL,
  };
  return map[status];
}

export function totalStatusColor(status: TotalStatus, colors: ColorPalette): string {
  const map: Record<TotalStatus, string> = {
    working: colors.success,
    completed: colors.success,
    suspended: colors.textDim,
    failed: colors.error,
    aborted: colors.warning,
  };
  return map[status];
}

export function totalStatusLabelColor(
  status: TotalStatus,
  members: readonly AgentSwarmMember[],
  colors: ColorPalette,
): string {
  if (status === 'working' && !members.some((member) => member.phase === 'completed')) {
    return colors.primary;
  }
  return totalStatusColor(status, colors);
}

export function allocateSegmentWidths(counts: readonly number[], width: number): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0 || width <= 0) return counts.map(() => 0);

  const exact = counts.map((count) => count * width / total);
  const widths = exact.map(Math.floor);
  let remaining = width - widths.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .toSorted((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const entry of order) {
    if (remaining <= 0) break;
    widths[entry.index] = (widths[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return widths;
}
