/**
 * Shared types for the tool-call component: subagent / sub-tool state and
 * the immutable snapshots group containers read from a ToolCallComponent.
 */

export type SubagentTextKind = 'thinking' | 'text';
export type SubagentPhase = 'queued' | 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded';

export interface FinishedSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
}

export interface OngoingSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly streamingArguments?: string | undefined;
}

export interface SubToolActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  phase: 'ongoing' | 'done' | 'failed';
  output?: string;
  readonly orderSeq: number;
}

/**
 * Immutable subagent state snapshot. `AgentGroupComponent` reads one-time
 * views via `ToolCallComponent.getSubagentSnapshot()` and renders its own
 * branch lines; `onSnapshotChange` notifies it when state changes.
 *
 * `latestActivity` priority, used only while running:
 *   1. latest ongoing sub-tool (`Using {name} ({keyArg})`)
 *   2. latest finished sub-tool (`Used {name} ({keyArg})`)
 *   3. last non-empty line from accumulated subagent text
 */
export interface ToolCallSubagentSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolCallDescription: string;
  readonly agentName: string | undefined;
  readonly phase: SubagentPhase | undefined;
  readonly toolCount: number;
  readonly elapsedSeconds: number | undefined;
  readonly tokens: number;
  readonly isError: boolean;
  readonly errorText: string | undefined;
  readonly latestActivity: string | undefined;
}

/**
 * Immutable Read tool state snapshot. `ReadGroupComponent` reads one-time
 * views via `ToolCallComponent.getReadSnapshot()` and sums lines for the group
 * header. `lines` is 0 while pending or failed, and the non-empty result line
 * count when done, matching the single-card chip.
 */
export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: 'pending' | 'done' | 'failed';
  readonly lines: number;
}
