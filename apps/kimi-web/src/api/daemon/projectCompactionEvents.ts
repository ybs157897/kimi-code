// apps/kimi-web/src/api/daemon/projectCompactionEvents.ts
// Context compaction raw event projection: started / completed / cancelled.

import type { AppEvent } from '../types';

export function projectCompactionCompleted(sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // Compaction replaced a batch of old messages with a summary on the
  // daemon side. The visible transcript is NOT reloaded (the client keeps
  // the scrollback and the reducer appends a divider marker); the
  // historyCompacted signal still fires so seq bookkeeping and any
  // non-compaction consumers stay correct.
  const result = (p?.result ?? {}) as Record<string, unknown>;
  out.push({
    type: 'compactionCompleted',
    sessionId,
    tokensBefore: typeof result.tokensBefore === 'number' ? result.tokensBefore : undefined,
    tokensAfter: typeof result.tokensAfter === 'number' ? result.tokensAfter : undefined,
    summary: typeof result.summary === 'string' ? result.summary : undefined,
  });
  out.push({
    type: 'historyCompacted',
    sessionId,
    beforeSeq: 0,
    reason: 'auto_compact',
  });
  return out;
}

export function projectCompactionStarted(sessionId: string, p: any): AppEvent[] {
  return [
    {
      type: 'compactionStarted',
      sessionId,
      trigger: p?.trigger === 'manual' ? 'manual' : 'auto',
      instruction: typeof p?.instruction === 'string' ? p.instruction : undefined,
    },
  ];
}

export function projectCompactionCancelled(sessionId: string): AppEvent[] {
  return [{ type: 'compactionCancelled', sessionId }];
}
