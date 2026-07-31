// apps/kimi-web/src/api/daemon/projectPromptEvents.ts
// Prompt lifecycle raw event projection: prompt.submitted (user message
// creation), prompt.completed and prompt.aborted (in-flight signals).

import type { AppEvent } from '../types';
import { cloneMessage, startUserMessage, toAppPromptContent } from './messageLog';
import type { SessionState } from './projectorState';

export function projectPromptSubmitted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const promptId: string | undefined = p?.promptId;
  const userMessageId: string | undefined = p?.userMessageId;
  if (!promptId || !userMessageId) return out;
  const content = toAppPromptContent(p?.content);
  if (content.length === 0) return out;
  s.currentPromptId = promptId;
  const msg = startUserMessage(
    s,
    sessionId,
    promptId,
    userMessageId,
    content,
    typeof p?.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
  );
  out.push({ type: 'messageCreated', message: cloneMessage(msg) });
  return out;
}

export function projectPromptCompleted(sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // No state change at AppEvent level — turn.ended / the session
  // status_changed ahead of this event already finished the prompt. The
  // event rides along so the web layer can spot the one case that has no
  // turn-level signal: a prompt blocked before any turn started (reason
  // 'blocked'), which would otherwise pin the in-flight state forever.
  const promptId: string | undefined = p?.promptId;
  if (typeof promptId === 'string' && promptId.length > 0) {
    out.push({ type: 'promptCompleted', sessionId, promptId, reason: p?.reason ?? 'completed' });
  }
  return out;
}

export function projectPromptAborted(sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // Fires both for an active-turn abort (a turn.ended + status_changed
  // precede it — the prompt is already finished) and for a QUEUED prompt
  // that never started a turn (no turn events, no status flip). The web
  // layer keys on promptId to clear the in-flight state in the latter case.
  const promptId: string | undefined = p?.promptId;
  if (typeof promptId === 'string' && promptId.length > 0) {
    out.push({ type: 'promptAborted', sessionId, promptId });
  }
  return out;
}
