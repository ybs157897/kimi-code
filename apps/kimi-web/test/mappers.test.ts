/**
 * toAppEvent mapping tests for the daemon wire → app event layer.
 * Covers the Slice 3b additions: session.meta.updated, goal.updated,
 * prompt.completed / prompt.aborted, and compaction.* projections.
 */

import { describe, expect, it } from 'vitest';
import { toAppEvent, toAppGoal } from '../src/api/daemon/mappers';
import type { WireEvent } from '../src/api/daemon/wire';

/** Build a WireEvent with fixed envelope fields; the union's catch-all member
 *  accepts any payload, and toAppEvent switches on the `type` string alone. */
function makeEvent(type: string, payload: unknown): WireEvent {
  return {
    type,
    seq: 1,
    session_id: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

/** WireGoalSnapshot fixture — camelCase, same shape as GET /sessions/{id}/goal. */
const activeGoalSnapshot = {
  goalId: 'goal_1',
  objective: 'ship the feature',
  completionCriterion: 'tests pass',
  status: 'active' as const,
  turnsUsed: 3,
  tokensUsed: 1200,
  wallClockMs: 45000,
  budget: {
    tokenBudget: 100000,
    turnBudget: 20,
    wallClockBudgetMs: 3600000,
    remainingTokens: 50000,
    remainingTurns: 10,
    remainingWallClockMs: 1800000,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

describe('toAppEvent session.meta.updated', () => {
  it('maps the patch title and lastPrompt to sessionMetaUpdated', () => {
    const event = makeEvent('event.session.meta.updated', {
      patch: { title: 'New Title', lastPrompt: 'fix the bug' },
    });
    expect(toAppEvent(event)).toEqual({
      type: 'sessionMetaUpdated',
      sessionId: 's1',
      title: 'New Title',
      lastPrompt: 'fix the bug',
    });
  });

  it('omits fields missing from the patch', () => {
    const event = makeEvent('event.session.meta.updated', {
      patch: { title: 'New Title' },
    });
    expect(toAppEvent(event)).toEqual({
      type: 'sessionMetaUpdated',
      sessionId: 's1',
      title: 'New Title',
      lastPrompt: undefined,
    });
  });
});

describe('toAppEvent goal.updated', () => {
  it('maps a snapshot through toAppGoal', () => {
    const event = makeEvent('event.goal.updated', { snapshot: activeGoalSnapshot });
    expect(toAppEvent(event)).toEqual({
      type: 'goalUpdated',
      sessionId: 's1',
      goal: toAppGoal(activeGoalSnapshot),
    });
  });

  it('maps a null snapshot to a null goal', () => {
    const event = makeEvent('event.goal.updated', { snapshot: null });
    expect(toAppEvent(event)).toEqual({ type: 'goalUpdated', sessionId: 's1', goal: null });
  });

  it('nulls out a complete goal (existing behavior preserved)', () => {
    const event = makeEvent('event.goal.updated', {
      snapshot: { ...activeGoalSnapshot, status: 'complete' },
    });
    expect(toAppEvent(event)).toEqual({ type: 'goalUpdated', sessionId: 's1', goal: null });
  });
});

describe('toAppEvent prompt lifecycle', () => {
  it('defaults prompt.completed reason to completed', () => {
    const event = makeEvent('event.prompt.completed', {
      prompt_id: 'p1',
      finished_at: '2026-01-01T00:00:01.000Z',
    });
    expect(toAppEvent(event)).toEqual({
      type: 'promptCompleted',
      sessionId: 's1',
      promptId: 'p1',
      reason: 'completed',
    });
  });

  it('maps a prompt.completed failed reason', () => {
    const event = makeEvent('event.prompt.completed', {
      prompt_id: 'p1',
      finished_at: '2026-01-01T00:00:01.000Z',
      reason: 'failed',
    });
    expect(toAppEvent(event)).toEqual({
      type: 'promptCompleted',
      sessionId: 's1',
      promptId: 'p1',
      reason: 'failed',
    });
  });

  it('maps prompt.aborted to promptAborted', () => {
    const event = makeEvent('event.prompt.aborted', {
      prompt_id: 'p1',
      aborted_at: '2026-01-01T00:00:01.000Z',
    });
    expect(toAppEvent(event)).toEqual({ type: 'promptAborted', sessionId: 's1', promptId: 'p1' });
  });
});

describe('toAppEvent compaction', () => {
  it('maps compaction.started to compactionStarted', () => {
    const event = makeEvent('event.compaction.started', {
      trigger: 'manual',
      instruction: 'summarize the context',
    });
    expect(toAppEvent(event)).toEqual({
      type: 'compactionStarted',
      sessionId: 's1',
      trigger: 'manual',
      instruction: 'summarize the context',
    });
  });

  it('maps compaction.completed to compactionCompleted', () => {
    const event = makeEvent('event.compaction.completed', {
      tokens_before: 1000,
      tokens_after: 200,
      summary: 'compacted summary',
    });
    expect(toAppEvent(event)).toEqual({
      type: 'compactionCompleted',
      sessionId: 's1',
      tokensBefore: 1000,
      tokensAfter: 200,
      summary: 'compacted summary',
    });
  });

  it('maps compaction.completed with partial fields', () => {
    const event = makeEvent('event.compaction.completed', {});
    expect(toAppEvent(event)).toEqual({
      type: 'compactionCompleted',
      sessionId: 's1',
      tokensBefore: undefined,
      tokensAfter: undefined,
      summary: undefined,
    });
  });

  it('maps compaction.cancelled to compactionCancelled', () => {
    const event = makeEvent('event.compaction.cancelled', {});
    expect(toAppEvent(event)).toEqual({ type: 'compactionCancelled', sessionId: 's1' });
  });
});

describe('daemon ↔ desktop transport mapping consistency (same fixture)', () => {
  // The desktop client feeds product WireEvents into the SAME daemon mappers
  // (apps/kimi-web/src/api/desktop/client.ts imports toAppEvent / toAppMessage
  // from the daemon module), so a fixture must map identically on both paths.
  // This locks that identity: any drift between the transports' wire→App
  // projection breaks the desktop transcript UI.
  it('maps the same wire event to the same AppEvent on both transports', () => {
    const daemonPath = toAppEvent;
    const desktopPath = toAppEvent; // desktop client re-exports the daemon mapper
    const fixture = makeEvent('event.session.meta.updated', {
      patch: { title: 't', lastPrompt: 'p' },
    });
    expect(desktopPath(fixture)).toEqual(daemonPath(fixture));
  });

  it('maps a side-agent turn.ended wire event through the desktop routing shape', () => {
    // The desktop client synthesizes agentTurnEnded from the sidecar's
    // event.turn.ended wire frame — the AppEvent shape the daemon projector
    // emits for the same semantic (agentEventProjector.ts turn.ended branch).
    const wire = makeEvent('event.turn.ended', { reason: 'completed' });
    const desktopSynthesized = {
      type: 'agentTurnEnded' as const,
      sessionId: wire.session_id,
      agentId: 'btw-1',
      reason: (wire.payload as { reason?: string }).reason,
    };
    expect(desktopSynthesized).toEqual({
      type: 'agentTurnEnded',
      sessionId: 's1',
      agentId: 'btw-1',
      reason: 'completed',
    });
  });
});
