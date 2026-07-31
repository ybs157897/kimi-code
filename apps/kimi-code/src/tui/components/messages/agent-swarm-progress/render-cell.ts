/**
 * Cell and cell-label rendering for the agent-swarm grid.
 */

import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { FAILURE_MARK, SUCCESS_MARK } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

import { ABORTED_LABEL, CANCELLED_MARK, PHASE_LABELS, QUEUED_LABEL } from './constants';
import {
  collapseWhitespace,
  latestNonEmptyLine,
  normalizeFinalOutputText,
  truncateWithColor,
} from './text';
import type { AgentSwarmMember, AgentSwarmPhase, AgentSwarmSnapshot } from './types';

export function renderCellLabel(
  member: AgentSwarmMember,
  snapshot: AgentSwarmSnapshot,
  width: number,
  colors: ColorPalette,
): string {
  const latestLine = latestNonEmptyLine(snapshot.latestModelText);
  if (snapshot.phase === 'running') {
    return truncateWithColor(runningCellLabelText(member), width, colors.textDim);
  }
  if (snapshot.phase === 'failed' && member.failureText !== undefined) {
    return truncateWithColor(`${FAILURE_MARK}${member.failureText}`, width, colors.error);
  }
  if (snapshot.phase === 'completed') {
    return renderCompletedCellLabel(member.completedText ?? latestLine, width, colors);
  }
  if (snapshot.phase === 'cancelled') {
    return renderCancelledCellLabel(member, width, colors);
  }
  return truncateWithColor(PHASE_LABELS[snapshot.phase], width, phaseColor(snapshot.phase, colors));
}

export function runningCellLabelText(member: AgentSwarmMember): string {
  const latestLine = latestNonEmptyLine(member.latestModelText);
  const itemText = collapseWhitespace(member.itemText);
  const text = latestLine.length > 0 ? latestLine : itemText;
  return text.length > 0 ? text : PHASE_LABELS.running;
}

export function phaseColor(phase: AgentSwarmPhase, colors: ColorPalette): string {
  const map: Record<AgentSwarmPhase, string> = {
    pending: colors.textDim,
    queued: colors.textDim,
    suspended: colors.textDim,
    running: colors.textDim,
    completed: colors.success,
    failed: colors.error,
    cancelled: colors.warning,
  };
  return map[phase];
}

export function renderCancelledCellLabel(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const labelText = member.cancelledLabelText ?? ABORTED_LABEL;
  const labelColor = member.cancelledLabelColor ?? colors.warning;
  const markColor = member.cancelledMarkColor ?? colors.warning;
  const labelStyle = chalk.hex(labelColor);
  return truncateToWidth(
    chalk.hex(markColor)(CANCELLED_MARK) + labelStyle(labelText),
    width,
    labelStyle('…'),
  );
}

export function renderCompletedCellLabel(
  text: string,
  width: number,
  colors: ColorPalette,
): string {
  const finalText = normalizeFinalOutputText(text);
  const label = finalText === undefined ? SUCCESS_MARK.trimEnd() : `${SUCCESS_MARK}${finalText}`;
  return truncateWithColor(label, width, colors.success);
}

export function compactTerminalMark(
  member: AgentSwarmMember,
  phase: AgentSwarmPhase,
  colors: ColorPalette,
): string {
  if (phase === 'completed') return chalk.hex(colors.success)(SUCCESS_MARK.trimEnd());
  if (phase === 'failed') return chalk.hex(colors.error)(FAILURE_MARK.trimEnd());
  if (phase === 'cancelled') {
    return chalk.hex(member.cancelledMarkColor ?? colors.warning)(CANCELLED_MARK.trimEnd());
  }
  return '';
}

export function renderPendingCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const itemText = collapseWhitespace(member.itemText);
  const label = itemText.length > 0 ? itemText : QUEUED_LABEL;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(label, labelWidth, colors.textDim);
}

export function renderQueuedCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(QUEUED_LABEL, labelWidth, colors.textDim);
}

export function renderCancelledUnstartedCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + renderCancelledCellLabel(member, labelWidth, colors);
}
