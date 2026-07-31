// apps/kimi-web/src/api/daemon/projectMiscEvents.ts
// Remaining single-event families: goal.updated, cron.fired, error, warning.

import type { AppEvent, AppMessage } from '../types';
import { mapGoalSnapshot } from './goalSnapshot';
import { cloneMessage } from './messageLog';
import { stringField, ulid } from './projectorHelpers';
import type { SessionState } from './projectorState';

export function projectGoalUpdated(sessionId: string, p: any): AppEvent[] {
  const goal = mapGoalSnapshot(p?.snapshot ?? null);
  return [
    {
      type: 'goalUpdated',
      sessionId,
      goal: goal?.status === 'complete' ? null : goal,
    },
  ];
}

export function projectCronFired(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // A scheduled reminder fired into the session. agent-core persists the
  // injected user message (so a refresh renders it via messagesToTurns),
  // but turn.steer() does NOT broadcast a prompt.submitted / message.created
  // for it — synthesize one here so the notice shows up live too. A later
  // snapshot reload replaces the message log wholesale, so this synthesized
  // copy never duplicates the persisted one. The promptId is intentionally
  // omitted: the web client caches every user message's promptId into
  // promptIdBySession for Stop/abort, and a synthetic id the daemon would
  // reject would clobber the real active promptId. The reducer already skips
  // optimistic-echo reconciliation for cron-origin messages, so no promptId
  // is needed for de-dup either.
  const origin = p?.origin;
  const promptText = stringField(p ?? {}, 'prompt');
  if (
    origin &&
    typeof origin === 'object' &&
    (origin as Record<string, unknown>)['kind'] === 'cron_job' &&
    promptText
  ) {
    const msg: AppMessage = {
      id: ulid('cron_'),
      sessionId,
      role: 'user',
      content: [{ type: 'text', text: promptText }],
      createdAt: new Date().toISOString(),
      metadata: { origin: origin as Record<string, unknown> },
    };
    s.messages.push(msg);
    out.push({ type: 'messageCreated', message: cloneMessage(msg) });
  }
  return out;
}

export function projectAgentError(p: any): AppEvent[] {
  // Fold into an unknown event so the reducer surfaces it as a structured
  // error notice (semantic title + code/status/requestId details). The
  // wire payload already carries name/details/retryable — pass them
  // through untouched; the reducer decides what to display.
  return [
    {
      type: 'unknown',
      raw: {
        _agentError: true,
        code: p?.code,
        message: p?.message,
        name: p?.name,
        details: p?.details,
        retryable: p?.retryable,
      },
    },
  ];
}

export function projectAgentWarning(p: any): AppEvent[] {
  return [
    {
      type: 'unknown',
      raw: { _agentWarning: true, message: p?.message },
    },
  ];
}
