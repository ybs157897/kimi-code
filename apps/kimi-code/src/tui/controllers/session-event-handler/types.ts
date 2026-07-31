/**
 * Type contract for the session event handler: the host the handler drives,
 * plus narrowed aliases for each agent event the dispatch switches on.
 */

import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/kimi-code-sdk';

import type { ColorToken } from '#/tui/theme';
import type { BtwPanelController } from '#/tui/controllers/btw-panel';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { TasksBrowserController } from '#/tui/controllers/tasks-browser';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  TranscriptEntry,
} from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import type { TUIAgentEvent } from '#/tui/runtime/agent-events-port';
import type { TUISessionRuntime } from '#/tui/runtime/tui-session-runtime';

export type AgentEventOf<T extends TUIAgentEvent['type']> = Extract<
  TUIAgentEvent,
  { readonly type: T }
>;
export type AgentStatusUpdatedEvent = AgentEventOf<'agent.status.updated'>;
export type AssistantDeltaEvent = AgentEventOf<'assistant.delta'>;
export type BackgroundTaskStartedEvent = AgentEventOf<'background.task.started'>;
export type BackgroundTaskTerminatedEvent = AgentEventOf<'background.task.terminated'>;
export type CompactionCancelledEvent = AgentEventOf<'compaction.cancelled'>;
export type CompactionCompletedEvent = AgentEventOf<'compaction.completed'>;
export type CompactionStartedEvent = AgentEventOf<'compaction.started'>;
export type CronFiredEvent = AgentEventOf<'cron.fired'>;
export type ErrorEvent = AgentEventOf<'error'>;
export type GoalUpdatedEvent = AgentEventOf<'goal.updated'>;
export type HookResultEvent = AgentEventOf<'hook.result'>;
export type NoticeEvent = AgentEventOf<'notice'>;
export type PluginCommandActivatedEvent = AgentEventOf<'plugin_command.activated'>;
export type SkillActivatedEvent = AgentEventOf<'skill.activated'>;
export type ThinkingDeltaEvent = AgentEventOf<'thinking.delta'>;
export type ToolCallDeltaEvent = AgentEventOf<'tool.call.delta'>;
export type ToolCallStartedEvent = AgentEventOf<'tool.call.started'>;
export type ToolProgressEvent = AgentEventOf<'tool.progress'>;
export type ToolResultEvent = AgentEventOf<'tool.result'>;
export type TurnEndedEvent = AgentEventOf<'turn.ended'>;
export type TurnStartedEvent = AgentEventOf<'turn.started'>;
export type TurnStepCompletedEvent = AgentEventOf<'turn.step.completed'>;
export type TurnStepInterruptedEvent = AgentEventOf<'turn.step.interrupted'>;
export type TurnStepStartedEvent = AgentEventOf<'turn.step.started'>;
export type WarningEvent = AgentEventOf<'warning'>;

export interface SessionEventHost {
  state: TUIState;
  aborted: boolean;
  runtimeEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSessionRuntime(): TUISessionRuntime;
  requestApprovalResponse(request: ApprovalRequest): Promise<ApprovalResponse>;
  requestQuestionResponse(request: QuestionRequest): Promise<QuestionResult>;
  recordApprovalResponse(request: ApprovalRequest, response: ApprovalResponse): void;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void;
  handleShellStarted(event: { commandId: string; taskId: string }): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}
