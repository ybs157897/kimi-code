// apps/kimi-web/src/api/daemon/projectDeltaEvents.ts
// Streamed text / thinking delta projection with wire-offset alignment
// (duplicate skipping and gap detection on the v2 sync protocol).

import type { AppEvent } from '../types';
import { appendAssistantDelta } from './messageLog';
import type { ProjectMeta } from './projectorTypes';
import type { SessionState } from './projectorState';

/**
 * Align a live text-delta against the per-turn accumulated length using the
 * wire `offset`. Returns 'skip' for duplicates (offset behind local state),
 * 'gap' when deltas were missed (offset ahead — trigger a re-snapshot), and
 * 'append' otherwise.
 */
function alignDelta(localLen: number, offset: number | undefined): 'append' | 'skip' | 'gap' {
  if (offset === undefined) return 'append';
  if (offset < localLen) return 'skip';
  if (offset > localLen) return 'gap';
  return 'append';
}

export function projectThinkingDelta(s: SessionState, sessionId: string, p: any, meta?: ProjectMeta): AppEvent[] {
  const out: AppEvent[] = [];
  const msgId = s.currentAssistantMsgId;
  if (!msgId) return out;
  const delta: string = p?.delta ?? '';
  if (!delta) return out;

  // Same missed-turn-boundary self-heal as assistant.delta (see there).
  if (meta?.offset === 0 && s.turnThinkLen > 0) {
    s.turnThinkLen = 0;
  }

  const align = alignDelta(s.turnThinkLen, meta?.offset);
  if (align === 'skip') return out;
  if (align === 'gap') {
    out.push({ type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'delta_gap' });
    return out;
  }

  const thinkIdx = appendAssistantDelta(s, msgId, 'thinking', delta);
  if (thinkIdx < 0) return out;
  s.turnThinkLen += delta.length;
  out.push({
    type: 'assistantDelta',
    sessionId,
    messageId: msgId,
    contentIndex: thinkIdx,
    delta: { thinking: delta },
  });
  return out;
}

export function projectAssistantDelta(s: SessionState, sessionId: string, p: any, meta?: ProjectMeta): AppEvent[] {
  const out: AppEvent[] = [];
  const msgId = s.currentAssistantMsgId;
  if (!msgId) return out;
  const delta: string = p?.delta ?? '';
  if (!delta) return out;

  // Self-heal a missed turn boundary: a pre-append offset of 0 while we
  // still believe we are mid-stream means the daemon began a fresh
  // assistant stream (new turn / retry) whose turn.started we never saw —
  // e.g. the durable replay and the live volatile deltas raced on the
  // cursor after a reconnect. Without this reset every delta has
  // offset < turnTextLen and is SILENTLY skipped forever (skip, unlike
  // gap, never recovers), so streaming dies until a full page reload.
  if (meta?.offset === 0 && s.turnTextLen > 0) {
    s.turnTextLen = 0;
  }

  const align = alignDelta(s.turnTextLen, meta?.offset);
  if (align === 'skip') return out;
  if (align === 'gap') {
    // Deltas were missed in the snapshot↔subscribe window — the only
    // exact recovery is a fresh snapshot. historyCompacted is routed to
    // onResync by the client wrapper, which reloads via snapshot.
    out.push({ type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'delta_gap' });
    return out;
  }

  const textIdx = appendAssistantDelta(s, msgId, 'text', delta);
  if (textIdx < 0) return out;
  s.turnTextLen += delta.length;
  out.push({
    type: 'assistantDelta',
    sessionId,
    messageId: msgId,
    contentIndex: textIdx,
    delta: { text: delta },
  });
  return out;
}
