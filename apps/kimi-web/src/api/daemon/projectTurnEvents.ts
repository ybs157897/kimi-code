// apps/kimi-web/src/api/daemon/projectTurnEvents.ts
// Turn lifecycle raw event projection: turn / step boundaries, prompt-id
// binding, assistant message creation, usage accumulation and retry reuse.

import type { AppEvent } from '../types';
import { cloneMessage, finishAssistantMessage, getMsgById, startAssistantMessage } from './messageLog';
import { normalizeUsage, numberField, ulid } from './projectorHelpers';
import { buildUsageSnapshot, type SessionState } from './projectorState';

export function projectTurnStarted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // Bind turnId → promptId. Generate a synthetic one if none was pre-bound.
  // Session busy is intentionally NOT projected here — the daemon's
  // `event.session.work_changed` is the single source of the busy fact
  // (it re-reads the authoritative drain registry and dedupes per real
  // transition); projecting a second busy flip per turn from the raw
  // stream made every turn-end consumer fire twice.
  const turnId: number = p?.turnId;
  const existingPromptId = s.currentPromptId ?? ulid('pr_');
  s.currentPromptId = existingPromptId;
  if (turnId !== undefined) {
    s.turnPromptId.set(turnId, existingPromptId);
  }
  // Fresh turn → fresh step stream offsets.
  s.turnTextLen = 0;
  s.turnThinkLen = 0;
  // Main-conversation liveness (the moon) keys off the main agent's turn
  // boundary directly — only main-agent frames reach this switch arm.
  out.push({ type: 'turnActiveChanged', sessionId, active: true });
  return out;
}

export function projectTurnStepStarted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const turnId: number = p?.turnId;
  let promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
  if (!promptId) {
    // Joined mid-turn (reconnect/resync wiped the binding): synthesize a
    // promptId like turn.started does, so the REST of the turn still
    // renders instead of every following event being dropped.
    promptId = ulid('pr_');
    s.currentPromptId = promptId;
    if (turnId !== undefined) s.turnPromptId.set(turnId, promptId);
  }

  // Fresh step → fresh stream offsets: the server's delta `offset` is
  // step-relative, so without this reset every delta from step 2 on is
  // silently skipped or misread as a gap.
  s.turnTextLen = 0;
  s.turnThinkLen = 0;

  // A retry continuation: refill the bubble turn.step.retrying cleared,
  // instead of creating a second bubble with the same step's content.
  if (s.retryReuseMsgId !== undefined) {
    const reuseId = s.retryReuseMsgId;
    s.retryReuseMsgId = undefined;
    if (getMsgById(s, reuseId) !== undefined) {
      s.currentAssistantMsgId = reuseId;
      return out;
    }
  }

  // Create a new pending assistant message
  const msg = startAssistantMessage(s, sessionId, promptId);
  s.currentAssistantMsgId = msg.id;

  out.push({ type: 'messageCreated', message: cloneMessage(msg) });
  return out;
}

export function projectTurnStepCompleted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const msgId = s.currentAssistantMsgId;

  // Feed usage
  const u = normalizeUsage(p?.usage);
  s.totalInput += u.input;
  s.totalOutput += u.output;
  s.totalCacheRead += u.cacheRead;
  s.totalCacheCreate += u.cacheCreate;

  if (msgId) {
    finishAssistantMessage(s, msgId);
    const msg = getMsgById(s, msgId);
    if (msg) {
      out.push({
        type: 'messageUpdated',
        sessionId,
        messageId: msgId,
        content: msg.content.map((c) => ({ ...c })),
        status: 'completed',
      });
    }
  }
  return out;
}

export function projectTurnEnded(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const msgId = s.currentAssistantMsgId;
  const reason: string = p?.reason ?? 'completed';
  const durationMs = numberField(p ?? {}, 'durationMs');

  // Main-conversation liveness: the prompt this turn served is done.
  // This — not the session-busy status — is what ends the working moon.
  // It MUST be emitted first in this arm: the onMainTurnEnd side effect
  // gates on `seq > lastSeqBySession`, and sibling events in this arm
  // advance that cursor — emitted after them, this event would compare
  // equal and the prompt-finish cleanup (moon, queue drain) would never
  // fire (observed: moon stuck when a turn ends with background tasks
  // still running, where no work_changed(busy:false) fallback exists).
  out.push({ type: 'turnActiveChanged', sessionId, active: false, reason: p?.reason });

  if (msgId) {
    finishAssistantMessage(s, msgId);
    const msg = getMsgById(s, msgId);
    if (msg) {
      out.push({
        type: 'messageUpdated',
        sessionId,
        messageId: msgId,
        content: msg.content.map((c) => ({ ...c })),
        status: reason === 'failed' || reason === 'blocked' ? 'error' : 'completed',
        durationMs,
      });
    }
  }

  s.turnCount++;
  const usageSnapshot = buildUsageSnapshot(s);
  out.push({ type: 'sessionUsageUpdated', sessionId, usage: usageSnapshot });

  // No busy projection here — see turn.started. The daemon's
  // `event.session.work_changed` flips the session busy fact.

  // Clear per-turn state. Reset the stream offsets too so a stale length
  // from this turn can't wedge the next turn's delta alignment into a
  // silent skip if its turn.started is missed across a reconnect. The
  // retry reuse target is per-turn as well: if the turn died between
  // turn.step.retrying and the retried step.started, the next prompt
  // must open a fresh bubble, not refill this turn's emptied one.
  s.currentAssistantMsgId = undefined;
  s.currentPromptId = undefined;
  s.turnTextLen = 0;
  s.turnThinkLen = 0;
  s.retryReuseMsgId = undefined;
  return out;
}

export function projectTurnStepRetrying(s: SessionState, sessionId: string): AppEvent[] {
  const out: AppEvent[] = [];
  // The step's stream restarts from offset 0. Reuse the abandoned
  // bubble instead of stacking a new one: strip its streamed parts and
  // keep the id in retryReuseMsgId so the retried step.started refills
  // it in place. Otherwise the failed attempt's partial bubble stays
  // rendered next to the retry's full stream — the "text/tool shown
  // twice" duplication (far more visible since the retry budget grew).
  const msgId = s.currentAssistantMsgId;
  if (msgId !== undefined) {
    const msg = getMsgById(s, msgId);
    if (msg !== undefined) {
      msg.content = msg.content.filter(
        (c) => c.type !== 'text' && c.type !== 'thinking' && c.type !== 'toolUse',
      );
      out.push({
        type: 'messageUpdated',
        sessionId,
        messageId: msgId,
        content: msg.content.map((c) => ({ ...c })),
        status: 'pending',
      });
      s.retryReuseMsgId = msgId;
    }
  }
  s.turnTextLen = 0;
  s.turnThinkLen = 0;
  s.toolStartTimes.clear();
  return out;
}

export function projectTurnStepInterrupted(s: SessionState): AppEvent[] {
  // Discard current assistant message; next step.started will create a
  // new one. Drop any pending retry reuse target for the same reason.
  s.currentAssistantMsgId = undefined;
  s.retryReuseMsgId = undefined;
  return [];
}
