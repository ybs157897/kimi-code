/**
 * `task` domain (L5) — builds detached task terminal-notification content:
 * the `AgentTaskNotification` payload shape and its context-build result, the
 * human-readable body (`buildAgentTaskNotificationBody`, with subagent resume
 * guidance), and the output child blocks (`agentTaskNotificationChildren` —
 * an output-file pointer when the full output is persisted, otherwise a
 * bounded buffered preview).
 */

import { userCancellationReason } from '#/_base/utils/abort';
import { escapeXml, escapeXmlAttr } from '#/_base/utils/xml-escape';
import type { ContentPart } from '#/kosong/contract/message';
import type { TaskOrigin } from '#/agent/contextMemory/types';
import type { AgentTaskInfo, AgentTaskOutputSnapshot } from './task';

export type AgentTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

export interface AgentTaskNotificationBuildContext {
  readonly content: readonly ContentPart[];
  readonly origin: TaskOrigin;
  readonly notification: AgentTaskNotification;
}

export const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;

export function agentTaskNotificationChildren(
  output: AgentTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: AgentTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

export function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.status === 'killed' && isSerializedUserCancellation(info.stopReason)
        ? `${info.description} was stopped by user.`
        : info.stopReason
          ? `${info.description} ${info.status === 'killed' ? 'was stopped' : info.status}. Reason: ${info.stopReason}`
          : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}

function isSerializedUserCancellation(reason: string | undefined): boolean {
  return reason === userCancellationReason().message;
}
