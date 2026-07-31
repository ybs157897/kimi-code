// apps/kimi-web/src/api/daemon/projectToolEvents.ts
// Tool lifecycle raw event projection: tool-call start (tool.use /
// tool.call.started), tool.progress output chunks and tool.result messages.

import type { AppEvent } from '../types';
import { appendToolResultMessage, appendToolUse, cloneMessage, getMsgById, toolProgressOutput } from './messageLog';
import { ulid } from './projectorHelpers';
import type { SessionState } from './projectorState';

/** Handles both `tool.use` and its alias `tool.call.started`. */
export function projectToolCallStarted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const msgId = s.currentAssistantMsgId;
  const turnId: number = p?.turnId;
  const promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
  if (!msgId || !promptId) return out;

  const toolCallId: string = p?.toolCallId;
  // Real daemon field name is 'name' per event-projector.ts
  const toolName: string = p?.name ?? p?.toolName ?? '';
  const args = p?.args ?? p?.input ?? {};

  appendToolUse(s, msgId, toolCallId, toolName, args);

  const msg = getMsgById(s, msgId);
  const contentIndex = msg ? msg.content.length - 1 : 0;

  // Record start time
  s.toolStartTimes.set(toolCallId, Date.now());

  // Emit messageUpdated so the reducer knows about the new tool-use slot
  if (msg) {
    out.push({
      type: 'messageUpdated',
      sessionId,
      messageId: msgId,
      content: msg.content.map((c) => ({ ...c })),
      status: 'pending',
    });
  }
  void contentIndex;
  return out;
}

export function projectToolProgress(sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const toolCallId: string = p?.toolCallId;
  const progress = toolProgressOutput(p ?? {});
  if (toolCallId && progress) {
    out.push({
      type: 'toolOutput',
      sessionId,
      toolCallId,
      outputChunk: progress.outputChunk,
      stream: progress.stream,
    });
  }
  return out;
}

export function projectToolResult(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const turnId: number = p?.turnId;
  let promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
  if (!promptId) {
    // Same mid-turn-join fallback as turn.step.started.
    promptId = ulid('pr_');
    s.currentPromptId = promptId;
    if (turnId !== undefined) s.turnPromptId.set(turnId, promptId);
  }

  const toolCallId: string = p?.toolCallId;
  const output = p?.output;
  const isError: boolean = p?.isError ?? false;

  const startTime = s.toolStartTimes.get(toolCallId) ?? Date.now();
  s.toolStartTimes.delete(toolCallId);
  void (Date.now() - startTime); // duration — unused at client level

  const resultMsg = appendToolResultMessage(s, sessionId, toolCallId, output, isError, promptId);
  out.push({ type: 'messageCreated', message: cloneMessage(resultMsg) });

  // Reset assistant message tracking — next step.started will create a fresh one
  s.currentAssistantMsgId = undefined;
  return out;
}
