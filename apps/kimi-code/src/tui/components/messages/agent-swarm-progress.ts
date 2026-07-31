/**
 * Renders the agent-swarm progress panel in the transcript.
 *
 * The component itself lives below; its module-level helpers, types, and
 * constants are split into the `./agent-swarm-progress/` submodules. This file
 * stays the public barrel: it re-exports the public API and defines the
 * component.
 */

import { truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import {
  AgentSwarmProgressEstimator,
} from '#/tui/components/messages/agent-swarm-progress-estimator';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { gradientText } from '#/tui/theme/gradient-text';

import {
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsFromArguments,
  agentSwarmPartialPromptTemplateFromArguments,
  agentSwarmPartialResumeItemsFromArguments,
  agentSwarmPromptTemplateFromArgs,
  agentSwarmResumeItemsFromArgs,
  agentSwarmWorkItemsStartedFromArguments,
} from './agent-swarm-progress/args';
import {
  ABORTED_LABEL,
  AGENT_SWARM_LEFT_INDENT,
  AGENT_SWARM_RIGHT_GAP,
  AGENT_SWARM_TITLE_ACCENT_BIAS,
  BRAILLE_LEVELS,
  CANCELLED_CLEAR_KEYS,
  CANCELLED_LABEL,
  COMPLETED_CLEAR_KEYS,
  COMPLETE_FILL_MS,
  FAILED_CLEAR_KEYS,
  FRAME_INTERVAL_MS,
  MAX_LATEST_MODEL_CHARS,
  ORCHESTRATING_LABEL,
  PROMPTING_LABEL,
  PROMPTING_TEXT_TRAILING_GAP,
  TERMINAL_CLEAR_KEYS,
  TOTAL_STATUS_BAR_GAP,
} from './agent-swarm-progress/constants';
import { calculateAgentSwarmGridLayout } from './agent-swarm-progress/grid-layout';
import {
  clearMemberState,
  createMembers,
  isTerminalPhase,
  summarizeSnapshots,
  terminalPhaseElapsedMs,
} from './agent-swarm-progress/members';
import {
  normalizeFailureText,
  parseAgentSwarmResultStatuses,
} from './agent-swarm-progress/parse';
import {
  brailleBar,
  cancelledLabelColor,
  cancelledProgressColor,
} from './agent-swarm-progress/render-bar';
import {
  compactTerminalMark,
  renderCancelledUnstartedCell,
  renderCellLabel,
  renderPendingCell,
  renderQueuedCell,
  runningCellLabelText,
} from './agent-swarm-progress/render-cell';
import {
  activityPrefixForTotalStatus,
  renderStatusLabel,
  renderStatusPipBar,
  totalStatus,
  totalStatusLabel,
  totalStatusLabelColor,
} from './agent-swarm-progress/render-status';
import {
  collapseWhitespace,
  normalizeFinalOutputText,
  padAnsi,
  truncateStartToWidth,
} from './agent-swarm-progress/text';
import type {
  AgentSwarmGridLayout,
  AgentSwarmMember,
  AgentSwarmProgressOptions,
  AgentSwarmSnapshot,
  AgentSwarmSummary,
  TotalStatus,
} from './agent-swarm-progress/types';

export type {
  AgentSwarmGridLayout,
  AgentSwarmGridLayoutInput,
  AgentSwarmProgressOptions,
  AgentSwarmResultSummary,
} from './agent-swarm-progress/types';
export { agentSwarmPartialItemsCountFromArguments } from './agent-swarm-progress/args';
export { agentSwarmGridHeightForTerminalRows } from './agent-swarm-progress/grid-layout';
export { agentSwarmResultSummaryFromOutput } from './agent-swarm-progress/parse';
export {
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsFromArguments,
  calculateAgentSwarmGridLayout,
};

export class AgentSwarmProgressComponent implements Component {
  private members: AgentSwarmMember[];
  private readonly progressEstimator = new AgentSwarmProgressEstimator();
  private description: string;
  private readonly requestRender: (() => void) | undefined;
  private readonly availableGridHeight: (() => number | undefined) | undefined;
  private inputComplete = false;
  private failed = false;
  private aborted = false;
  private itemsStarted = false;
  private toolCallActive = true;
  private promptTemplateText = '';
  private activitySpinnerText: (() => string) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentSwarmProgressOptions) {
    this.description = options.description;
    this.requestRender = options.requestRender;
    this.availableGridHeight = options.availableGridHeight;
    this.members = [];
  }

  /** Live palette, read on each render so a theme switch recolors the panel. */
  private get colors(): ColorPalette {
    return currentTheme.palette;
  }

  dispose(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  setActivitySpinnerText(provider: (() => string) | undefined): void {
    if (!this.toolCallActive) return;
    this.activitySpinnerText = provider;
  }

  markToolCallEnded(): void {
    this.toolCallActive = false;
    this.activitySpinnerText = undefined;
  }

  isToolCallActive(): boolean {
    return this.toolCallActive;
  }

  isRequestStreaming(): boolean {
    return !this.inputComplete;
  }

  updateArgs(
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): void {
    const streamingArguments = options.streamingArguments;
    const description = agentSwarmDescriptionFromArgs(args);
    if (description.length > 0 || this.description.length === 0) {
      this.description = description;
    }
    const fullRows = [...agentSwarmResumeItemsFromArgs(args), ...agentSwarmItemsFromArgs(args)];
    const partialRows = streamingArguments === undefined
      ? []
      : [
          ...agentSwarmPartialResumeItemsFromArguments(streamingArguments),
          ...agentSwarmPartialItemsFromArguments(streamingArguments),
        ];
    if (
      fullRows.length > 0 ||
      partialRows.length > 0 ||
      (streamingArguments !== undefined && agentSwarmWorkItemsStartedFromArguments(streamingArguments))
    ) {
      this.itemsStarted = true;
    }
    const fullPromptTemplate = agentSwarmPromptTemplateFromArgs(args);
    const partialPromptTemplate =
      streamingArguments === undefined
        ? ''
        : agentSwarmPartialPromptTemplateFromArguments(streamingArguments);
    const promptTemplate =
      fullPromptTemplate.length > 0 ? fullPromptTemplate : partialPromptTemplate;
    if (promptTemplate.length > 0 || this.promptTemplateText.length === 0) {
      this.promptTemplateText = promptTemplate;
    }

    const itemCount = Math.max(fullRows.length, partialRows.length);
    if (itemCount > 0) this.ensureMemberCount(itemCount);
    this.updateItemTexts(fullRows, partialRows);
  }

  markInputComplete(): void {
    if (!this.inputComplete) {
      this.inputComplete = true;
      for (const member of this.members) {
        if (member.phase === 'pending') member.phase = 'queued';
      }
    }
    this.startAnimationIfNeeded();
  }

  registerSubagent(input: {
    readonly agentId: string;
    readonly swarmIndex?: number;
    readonly description?: string | undefined;
  }): void {
    const member = this.findMemberForSubagent(input.agentId, input.swarmIndex);
    if (member === undefined) return;
    member.agentId = input.agentId;
    if (member.phase === 'pending') member.phase = 'queued';
    this.startAnimationIfNeeded();
  }

  markStarted(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    const nowMs = Date.now();
    this.progressEstimator.markStarted(member.id, nowMs);
    member.ticks = Math.max(member.ticks, 1);
    this.promoteToRunning(member, nowMs);
    this.startAnimationIfNeeded();
  }

  recordToolCall(input: {
    readonly agentId: string;
    readonly toolCallId: string;
  }): void {
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined) return;
    const result = this.progressEstimator.recordToolCall({
      memberKey: member.id,
      toolCallId: input.toolCallId,
      nowMs: Date.now(),
    });
    if (!result.accepted) return;
    member.ticks = result.rawTicks;
    this.promoteToRunning(member);
    this.startAnimationIfNeeded();
  }

  appendModelDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined || input.delta.length === 0) return;
    member.latestModelText = `${member.latestModelText}${input.delta}`.slice(
      -MAX_LATEST_MODEL_CHARS,
    );
    this.promoteToRunning(member, Date.now(), true);
  }

  markCompleted(agentId: string, completedText?: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined || member.phase === 'failed' || member.phase === 'cancelled') return;
    const nowMs = Date.now();
    this.completeMember(member, nowMs, completedText);
    this.startAnimationIfNeeded();
  }

  markSuspended(input: {
    readonly agentId: string;
    readonly reason: string;
    readonly swarmIndex?: number;
    readonly description?: string | undefined;
  }): void {
    const member = this.findMemberByAgentId(input.agentId) ??
      this.findMemberForSubagent(input.agentId, input.swarmIndex);
    if (member === undefined || member.phase === 'completed' || member.phase === 'cancelled') return;
    member.agentId = input.agentId;
    this.progressEstimator.markQueued(member.id, Date.now());
    member.phase = 'suspended';
    clearMemberState(member, ...TERMINAL_CLEAR_KEYS);
    this.startAnimationIfNeeded();
  }

  markFailed(agentId: string, failureText?: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    const nowMs = Date.now();
    this.failMember(member, nowMs, failureText);
    this.startAnimationIfNeeded();
  }

  markSwarmFailed(failureText?: string): void {
    this.failed = true;
    this.aborted = false;
    const nowMs = Date.now();
    for (const member of this.members) {
      if (isTerminalPhase(member.phase)) continue;
      this.failMember(member, nowMs, failureText);
    }
    this.startAnimationIfNeeded();
  }

  markCancelled(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    this.cancelMember(member, Date.now());
  }

  markActiveCancelled(): void {
    this.aborted = true;
    const nowMs = Date.now();
    for (const member of this.members) {
      if (isTerminalPhase(member.phase)) continue;
      this.cancelMember(member, nowMs);
    }
    this.startAnimationIfNeeded();
  }

  applyResult(output: string): boolean {
    const statuses = parseAgentSwarmResultStatuses(output);
    if (statuses.length === 0) return false;
    this.aborted = false;
    const nowMs = Date.now();
    for (const entry of statuses) {
      this.ensureMemberCount(entry.index);
      const member = this.members[entry.index - 1];
      if (member === undefined) continue;
      if (entry.status === 'completed') {
        this.completeMember(member, nowMs, entry.completedText);
      } else if (entry.status === 'failed') {
        this.failMember(member, nowMs, entry.failureText);
      } else {
        this.cancelMember(member, nowMs);
      }
    }
    this.startAnimationIfNeeded();
    return true;
  }

  render(width: number): string[] {
    const outerWidth = Math.max(1, width);
    const innerWidth = Math.max(
      1,
      outerWidth - visibleWidth(AGENT_SWARM_LEFT_INDENT) - AGENT_SWARM_RIGHT_GAP,
    );
    if (this.members.length === 0) {
      const lines = [
        '',
        this.renderHeader(innerWidth, undefined),
        '',
        this.renderStatusLine(innerWidth),
        '',
      ];
      return this.indentLines(lines, outerWidth);
    }

    const nowMs = Date.now();
    const snapshots = this.members.map((member): AgentSwarmSnapshot => ({
      phase: member.phase,
      ticks: member.ticks,
      latestModelText: member.latestModelText,
      phaseElapsedMs: terminalPhaseElapsedMs(member, nowMs),
    }));
    const summary = summarizeSnapshots(snapshots);
    const lines = [
      '',
      this.renderHeader(innerWidth, summary),
      '',
      ...this.renderGrid(
        innerWidth,
        this.availableGridHeight?.(),
        snapshots,
        nowMs,
      ),
      '',
      this.renderStatusLine(innerWidth),
      '',
    ];
    this.startAnimationIfNeeded();
    return this.indentLines(lines, outerWidth);
  }

  private indentLines(lines: readonly string[], width: number): string[] {
    const contentWidth = Math.max(
      0,
      width - visibleWidth(AGENT_SWARM_LEFT_INDENT) - AGENT_SWARM_RIGHT_GAP,
    );
    return lines.map((line) =>
      truncateToWidth(
        AGENT_SWARM_LEFT_INDENT + truncateToWidth(line, contentWidth),
        width,
      )
    );
  }

  private renderHeader(width: number, _summary: AgentSwarmSummary | undefined): string {
    if (width <= 3) return chalk.hex(this.colors.primary)('─'.repeat(width));

    const title = gradientText('Agent Swarm', this.colors.primary, this.colors.accent, AGENT_SWARM_TITLE_ACCENT_BIAS);
    const description =
      this.description.length > 0
        ? chalk.hex(this.colors.primary)(' ─ ') + chalk.hex(this.colors.text)(this.description)
        : '';
    const prefixText = '─ ';
    const labelWidth = Math.max(1, width - visibleWidth(prefixText) - 1);
    const label = truncateToWidth(title + description, labelWidth);
    const suffixWidth = Math.max(0, width - visibleWidth(prefixText) - visibleWidth(label));
    const suffix = suffixWidth === 0 ? '' : ` ${'─'.repeat(Math.max(0, suffixWidth - 1))}`;
    return chalk.hex(this.colors.primary)(prefixText) + label + chalk.hex(this.colors.primary)(suffix);
  }

  private renderStatusLine(width: number): string {
    const status = totalStatus(this.members, {
      failed: this.failed,
      aborted: this.aborted,
    });
    const prefix = this.renderActivityPrefix(status);
    if (prefix.length > 0) {
      const contentWidth = Math.max(0, width - visibleWidth(prefix));
      if (contentWidth <= 0) return truncateToWidth(prefix, width);
      return truncateToWidth(`${prefix}${this.renderStatusLineContent(contentWidth, status)}`, width);
    }
    return this.renderStatusLineContent(width, status);
  }

  private renderActivityPrefix(status: TotalStatus): string {
    if (this.toolCallActive) return this.activitySpinnerText?.() ?? '';
    return activityPrefixForTotalStatus(status, this.colors);
  }

  private renderStatusLineContent(width: number, status: TotalStatus): string {
    if (status !== 'working') return this.renderProgressStatusLine(width, status);

    if (!this.inputComplete) {
      return this.renderOrchestratingStatusLine(width);
    }

    return this.renderProgressStatusLine(width, status);
  }

  private renderProgressStatusLine(width: number, status: TotalStatus): string {
    const label = renderStatusLabel(
      totalStatusLabel(status),
      totalStatusLabelColor(status, this.members, this.colors),
    );
    if (this.members.length === 0) return truncateToWidth(label, width);
    const barWidth = Math.max(0, width - visibleWidth(label) - TOTAL_STATUS_BAR_GAP);
    if (barWidth <= 0) return truncateToWidth(label, width);
    return truncateToWidth(
      `${label}${' '.repeat(TOTAL_STATUS_BAR_GAP)}${renderStatusPipBar(this.members, barWidth, this.colors)}`,
      width,
    );
  }

  private renderOrchestratingStatusLine(width: number): string {
    if (this.itemsStarted) {
      return truncateToWidth(
        renderStatusLabel(ORCHESTRATING_LABEL, this.colors.primary),
        width,
      );
    }

    const promptTemplate = collapseWhitespace(this.promptTemplateText);
    const label = renderStatusLabel(
      promptTemplate.length > 0 ? PROMPTING_LABEL : ORCHESTRATING_LABEL,
      this.colors.primary,
    );
    if (promptTemplate.length === 0) return truncateToWidth(label, width);

    const availablePromptWidth = Math.max(
      0,
      width - visibleWidth(label) - PROMPTING_TEXT_TRAILING_GAP,
    );
    const separator = visibleWidth(promptTemplate) <= availablePromptWidth - 1 ? ' ' : '  ';
    const promptWidth = Math.max(0, availablePromptWidth - visibleWidth(separator));
    if (promptWidth <= 0) return truncateToWidth(label, width);
    const prompt = chalk.hex(this.colors.textDim)(truncateStartToWidth(promptTemplate, promptWidth));
    return truncateToWidth(`${label}${separator}${prompt}`, width);
  }

  private renderGrid(
    width: number,
    height: number | undefined,
    snapshots: readonly AgentSwarmSnapshot[],
    nowMs: number,
  ): string[] {
    const layout = calculateAgentSwarmGridLayout({
      width,
      height: height ?? Number.POSITIVE_INFINITY,
      count: this.members.length,
    });
    const columns = Math.max(1, layout.columns);
    const rows = layout.rows;
    const cellGap = ' '.repeat(layout.columnGap);
    const leftPadding = ' '.repeat(layout.leftPadding);
    const lines: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col;
        const member = this.members[index];
        const snapshot = snapshots[index];
        if (member === undefined || snapshot === undefined) continue;
        cells.push(padAnsi(this.renderCell(member, snapshot, layout, nowMs), layout.cellWidth));
      }
      lines.push(leftPadding + cells.join(cellGap));
    }
    return lines;
  }

  private renderCell(
    member: AgentSwarmMember,
    snapshot: AgentSwarmSnapshot,
    layout: AgentSwarmGridLayout,
    nowMs: number,
  ): string {
    const width = layout.cellWidth;
    if (snapshot.phase === 'pending') {
      return renderPendingCell(member, width, this.colors);
    }
    if (snapshot.phase === 'cancelled' && snapshot.ticks <= 0) {
      return renderCancelledUnstartedCell(member, width, this.colors);
    }
    if (!layout.renderText) {
      return this.renderCompactCell(member, snapshot, layout.barCells, nowMs);
    }
    if (snapshot.phase === 'queued' && snapshot.ticks <= 0) {
      return renderQueuedCell(member, width, this.colors);
    }

    const estimate = this.progressEstimator.estimate({
      memberKey: member.id,
      phase: snapshot.phase,
      capacityTicks: layout.barCells * BRAILLE_LEVELS.length,
      nowMs,
    });
    const id = chalk.hex(this.colors.primary)(member.id);
    const bar = brailleBar(
      estimate.displayTicks,
      snapshot.phase,
      layout.barCells,
      this.colors,
      snapshot.phaseElapsedMs,
      cancelledProgressColor(member, snapshot.phase, this.colors),
    );
    const prefix = `${id} ${bar} `;
    const labelWidth = Math.max(1, width - visibleWidth(prefix));
    const label = renderCellLabel(member, snapshot, labelWidth, this.colors);
    return prefix + label;
  }

  private renderCompactCell(
    member: AgentSwarmMember,
    snapshot: AgentSwarmSnapshot,
    barCells: number,
    nowMs: number,
  ): string {
    const estimatePhase = snapshot.phase === 'pending' ? 'queued' : snapshot.phase;
    const estimate = this.progressEstimator.estimate({
      memberKey: member.id,
      phase: estimatePhase,
      capacityTicks: barCells * BRAILLE_LEVELS.length,
      nowMs,
    });
    const id = chalk.hex(this.colors.primary)(member.id);
    const bar = brailleBar(
      estimate.displayTicks,
      estimatePhase,
      barCells,
      this.colors,
      snapshot.phaseElapsedMs,
      cancelledProgressColor(member, snapshot.phase, this.colors),
    );
    return `${id} ${bar}${compactTerminalMark(member, snapshot.phase, this.colors)}`;
  }

  private findMemberForSubagent(
    agentId: string,
    swarmIndex: number | undefined,
  ): AgentSwarmMember | undefined {
    const existing = this.findMemberByAgentId(agentId);
    if (existing !== undefined) return existing;

    if (swarmIndex !== undefined && Number.isInteger(swarmIndex) && swarmIndex > 0) {
      this.ensureMemberCount(swarmIndex);
      const byIndex = this.members[swarmIndex - 1];
      if (byIndex !== undefined) return byIndex;
    }

    const unassigned = this.members.find((member) => member.agentId === undefined);
    if (unassigned !== undefined) return unassigned;

    this.ensureMemberCount(this.members.length + 1);
    return this.members.at(-1);
  }

  private findMemberByAgentId(agentId: string): AgentSwarmMember | undefined {
    return this.members.find((member) => member.agentId === agentId);
  }

  private ensureMemberCount(count: number): void {
    if (count <= this.members.length) return;
    const previousLength = this.members.length;
    this.members = [
      ...this.members,
      ...createMembers(count, this.inputComplete ? 'queued' : 'pending').slice(this.members.length),
    ];
    const nowMs = Date.now();
    for (let index = previousLength; index < this.members.length; index += 1) {
      const member = this.members[index];
      if (member !== undefined) this.progressEstimator.ensureMember(member.id, nowMs);
    }
  }

  private updateItemTexts(fullItems: readonly string[], partialItems: readonly string[]): void {
    const count = Math.max(fullItems.length, partialItems.length, this.members.length);
    for (let index = 0; index < count; index += 1) {
      const member = this.members[index];
      if (member === undefined) continue;
      const itemText = fullItems[index] ?? partialItems[index];
      if (itemText !== undefined) member.itemText = itemText;
    }
  }

  private startAnimationIfNeeded(): void {
    if (this.requestRender === undefined || this.timer !== undefined) return;
    if (!this.hasAnimatedMembers()) return;
    const requestRender = this.requestRender;
    this.timer = setInterval(() => {
      requestRender();
      if (!this.hasAnimatedMembers()) this.dispose();
    }, FRAME_INTERVAL_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  private hasAnimatedMembers(): boolean {
    const now = Date.now();
    return (
      this.progressEstimator.hasPendingCatchup() ||
      this.members.some((member) =>
        (
          member.phase === 'completed' &&
          member.completedAtMs !== undefined &&
          now - member.completedAtMs < COMPLETE_FILL_MS
        ) ||
        (
          member.phase === 'failed' &&
          member.failedAtMs !== undefined &&
          now - member.failedAtMs < COMPLETE_FILL_MS
        ),
      )
    );
  }

  private promoteToRunning(member: AgentSwarmMember, nowMs?: number, setTicks = false): void {
    if (member.phase === 'pending' || member.phase === 'queued' || member.phase === 'suspended') {
      member.phase = 'running';
      if (nowMs !== undefined) this.progressEstimator.markStarted(member.id, nowMs);
      if (setTicks) member.ticks = Math.max(member.ticks, 1);
    }
    delete member.suspendedReason;
  }

  private completeMember(member: AgentSwarmMember, nowMs: number, completedText?: string): void {
    if (member.phase !== 'completed') {
      this.progressEstimator.markCompleted(member.id, nowMs);
      member.completedAtMs = nowMs;
    }
    const normalizedCompletedText = normalizeFinalOutputText(completedText);
    if (normalizedCompletedText !== undefined) member.completedText = normalizedCompletedText;
    member.phase = 'completed';
    clearMemberState(member, ...COMPLETED_CLEAR_KEYS);
  }

  private failMember(member: AgentSwarmMember, nowMs: number, failureText?: string): void {
    if (member.phase !== 'failed') {
      this.progressEstimator.markFailed(member.id, nowMs);
      member.failedAtMs = nowMs;
    }
    const normalizedFailureText = normalizeFailureText(failureText);
    if (normalizedFailureText !== undefined) member.failureText = normalizedFailureText;
    member.phase = 'failed';
    clearMemberState(member, ...FAILED_CLEAR_KEYS);
  }

  private cancelMember(member: AgentSwarmMember, nowMs: number): void {
    const previousPhase = member.phase;
    this.progressEstimator.markCancelled(member.id, nowMs);
    member.phase = 'cancelled';
    clearMemberState(member, ...CANCELLED_CLEAR_KEYS);
    if (previousPhase === 'pending' || previousPhase === 'queued' || previousPhase === 'suspended') {
      member.cancelledLabelText = CANCELLED_LABEL;
      member.cancelledLabelColor = cancelledLabelColor(this.colors);
      member.cancelledMarkColor = this.colors.warning;
      member.cancelledBarColor = this.colors.warning;
    } else if (previousPhase === 'running') {
      member.cancelledLabelText = runningCellLabelText(member);
      member.cancelledLabelColor = cancelledLabelColor(this.colors);
      member.cancelledMarkColor = this.colors.warning;
      member.cancelledBarColor = this.colors.warning;
    } else {
      member.cancelledLabelText = ABORTED_LABEL;
      member.cancelledLabelColor = this.colors.warning;
      member.cancelledMarkColor = this.colors.warning;
      member.cancelledBarColor = this.colors.warning;
    }
  }
}
