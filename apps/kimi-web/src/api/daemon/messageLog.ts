// apps/kimi-web/src/api/daemon/messageLog.ts
// Message-log helpers for the agent event projector (inlined; mirrors
// message-log.ts).

import type { AppMessage, AppMessageContent } from '../types';
import { toAppMessageContent } from './mappers';
import { ulid } from './projectorHelpers';
import type { SessionState } from './projectorState';
import type { WireMessageContent } from './wire';

/**
 * Decouple an emitted message from the projector's internal log. The reducer
 * stores emitted messages by reference; the projector keeps mutating its own
 * copy in place (`slot.text += delta`), so sharing the content objects makes
 * the reducer's delta-append run on already-appended text — the first streamed
 * chunk of every text/thinking block rendered twice.
 */
export function cloneMessage(msg: AppMessage): AppMessage {
  return { ...msg, content: msg.content.map((c) => ({ ...c })) };
}

export function startAssistantMessage(state: SessionState, sessionId: string, promptId: string): AppMessage {
  const msg: AppMessage = {
    id: ulid('msg_'),
    sessionId,
    role: 'assistant',
    content: [],
    createdAt: new Date().toISOString(),
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

export function startUserMessage(
  state: SessionState,
  sessionId: string,
  promptId: string,
  userMessageId: string,
  content: AppMessageContent[],
  createdAt: string,
): AppMessage {
  const msg: AppMessage = {
    id: userMessageId,
    sessionId,
    role: 'user',
    content,
    createdAt,
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

export function toAppPromptContent(raw: unknown): AppMessageContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((part) => toAppMessageContent(part as WireMessageContent));
}

/**
 * Append a streamed text/thinking delta in stream order: continue the LAST
 * content part when it has the same type, otherwise open a NEW part at the
 * end. Returns the content index written (-1 if the message is unknown) so
 * the emitted assistantDelta targets the same slot in the reducer.
 *
 * No per-type fixed slots: a step that goes think → text → think again gets
 * three parts in call order instead of all thinking collapsing into one slot.
 */
export function appendAssistantDelta(
  state: SessionState,
  messageId: string,
  kind: 'text' | 'thinking',
  delta: string,
): number {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return -1;
  const last = msg.content.at(-1);
  if (last && last.type === kind) {
    if (kind === 'text') (last as { type: 'text'; text: string }).text += delta;
    else (last as { type: 'thinking'; thinking: string }).thinking += delta;
    return msg.content.length - 1;
  }
  msg.content.push(kind === 'text' ? { type: 'text', text: delta } : { type: 'thinking', thinking: delta });
  return msg.content.length - 1;
}

export function appendToolUse(
  state: SessionState,
  messageId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  outputLines?: string[],
): void {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  msg.content.push({ type: 'toolUse', toolCallId, toolName, input, outputLines });
}

export function toolProgressOutput(payload: Record<string, unknown>): { outputChunk: string; stream: 'stdout' | 'stderr' } | null {
  const update = payload['update'];
  const updateRecord = update && typeof update === 'object' ? update as Record<string, unknown> : null;
  const streamRaw = updateRecord?.['stream'] ?? updateRecord?.['kind'] ?? payload['stream'];
  const stream = streamRaw === 'stderr' ? 'stderr' : 'stdout';
  const chunk =
    (typeof updateRecord?.['text'] === 'string' && updateRecord['text']) ||
    (typeof updateRecord?.['message'] === 'string' && updateRecord['message']) ||
    (typeof payload['chunk'] === 'string' && payload['chunk']) ||
    (typeof payload['output'] === 'string' && payload['output']) ||
    (typeof payload['message'] === 'string' && payload['message']) ||
    '';
  return chunk.length > 0 ? { outputChunk: chunk, stream } : null;
}

export function finishAssistantMessage(state: SessionState, messageId: string): void {
  const msg = state.messages.find((m) => m.id === messageId);
  // We record nothing extra here — status is implicit in the downstream reducer
  void msg;
}

export function appendToolResultMessage(
  state: SessionState,
  sessionId: string,
  toolCallId: string,
  output: unknown,
  isError: boolean,
  promptId: string,
): AppMessage {
  const msg: AppMessage = {
    id: ulid('msg_'),
    sessionId,
    role: 'tool',
    content: [{ type: 'toolResult', toolCallId, output, isError }],
    createdAt: new Date().toISOString(),
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

export function getMsgById(state: SessionState, messageId: string): AppMessage | undefined {
  return state.messages.find((m) => m.id === messageId);
}
