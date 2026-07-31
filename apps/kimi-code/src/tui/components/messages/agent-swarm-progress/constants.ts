/**
 * Rendering constants for the agent-swarm progress panel (sizes, timers,
 * labels, status-bar order, and the per-phase clear-key sets).
 */

import type { AgentSwarmPhase, ClearableMemberKey } from './types';

export const TEXT_CELL_PREFERRED_WIDTH = 30;
export const CELL_GAP = '  ';
export const FRAME_INTERVAL_MS = 80;
export const TEXT_BRAILLE_BAR_MIN_WIDTH = 6;
export const BRAILLE_BAR_MAX_WIDTH = 8;
export const BRAILLE_EMPTY = '⣀';
export const BRAILLE_RIGHT_COLUMN_FULL = '⢸';
export const BRAILLE_LEVELS = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
export const PHASE_LABEL_WIDTH = 'Completed'.length;
export const MIN_LABEL_WIDTH = PHASE_LABEL_WIDTH;
export const MAX_LATEST_MODEL_CHARS = 2_000;
export const COMPLETE_FILL_MS = 360;
export const FAILED_PLACEHOLDER_RED_FACTOR = 0.75;
export const FAILED_PLACEHOLDER_NON_RED_FACTOR = 0.25;
export const STATUS_BAR_CHAR = '━';
export const CANCELLED_MARK = '⊘ ';
export const TOTAL_STATUS_BAR_GAP = 2;
export const PROMPTING_TEXT_TRAILING_GAP = 1;
export const ACTIVITY_SPINNER_PLACEHOLDER = '  ';
export const AGENT_SWARM_LEFT_INDENT = ' ';
export const AGENT_SWARM_RIGHT_GAP = 1;
export const AGENT_SWARM_NON_GRID_LINES = 6;
export const COMPACT_TERMINAL_MARK_WIDTH = 1;
export const ORCHESTRATING_LABEL = 'Orchestrating...';
export const PROMPTING_LABEL = 'Prompting...';
export const WORKING_LABEL = 'Working...';
export const COMPLETED_LABEL = 'Completed.';
export const FAILED_LABEL = 'Failed.';
export const ABORTED_LABEL = 'Aborted.';
export const CANCELLED_LABEL = 'Cancelled.';
export const QUEUED_LABEL = 'Queued...';
export const SUSPENDED_LABEL = 'Rate limited...';
export const RESUMED_ITEM_LABEL = '(resumed)';
export const CANCELLED_LABEL_DARKEN_FACTOR = 0.72;
export const AGENT_SWARM_TITLE_ACCENT_BIAS = 1.3;

export const STATUS_BAR_ORDER = [
  'completed',
  'working',
  'suspended',
  'queued',
  'cancelled',
  'failed',
] as const;
export type StatusBarPhase = typeof STATUS_BAR_ORDER[number];

export const PHASE_LABELS: Record<AgentSwarmPhase, string> = {
  pending: QUEUED_LABEL,
  queued: QUEUED_LABEL,
  suspended: SUSPENDED_LABEL,
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: ABORTED_LABEL,
};

export const COMPLETED_CLEAR_KEYS = [
  'failedAtMs',
  'failureText',
  'cancelledLabelText',
  'cancelledLabelColor',
  'cancelledMarkColor',
  'cancelledBarColor',
  'suspendedReason',
] as const satisfies readonly ClearableMemberKey[];
export const FAILED_CLEAR_KEYS = [
  'completedAtMs',
  'completedText',
  'cancelledLabelText',
  'cancelledLabelColor',
  'cancelledMarkColor',
  'cancelledBarColor',
  'suspendedReason',
] as const satisfies readonly ClearableMemberKey[];
export const TERMINAL_CLEAR_KEYS = [
  'completedAtMs',
  'completedText',
  'failedAtMs',
  'failureText',
  'cancelledLabelText',
  'cancelledLabelColor',
  'cancelledMarkColor',
  'cancelledBarColor',
  'suspendedReason',
] as const satisfies readonly ClearableMemberKey[];
export const CANCELLED_CLEAR_KEYS = [
  'completedAtMs',
  'completedText',
  'failedAtMs',
  'failureText',
  'suspendedReason',
] as const satisfies readonly ClearableMemberKey[];
