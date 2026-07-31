// apps/kimi-web/src/api/daemon/projectorState.ts
// Per-session projector state and its usage snapshot builder.

import type { AppMessage, AppSessionUsage, AppTask } from '../types';

// ---------------------------------------------------------------------------
// Per-session projector state
// ---------------------------------------------------------------------------

export interface SessionState {
  // Turn ID → promptId binding
  turnPromptId: Map<number, string>;
  currentPromptId: string | undefined;

  // Assistant message tracking
  currentAssistantMsgId: string | undefined;

  // Per-step accumulated stream lengths — aligned against the (step-relative)
  // wire `offset` on volatile delta frames (v2 sync protocol) to skip
  // duplicates and detect gaps after a snapshot seed.
  turnTextLen: number;
  turnThinkLen: number;

  // Tool timing
  toolStartTimes: Map<string, number>;

  // Usage accumulator
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  contextTokens: number;
  contextLimit: number;
  turnCount: number;
  model: string;

  // In-memory message log (mirrors daemon message-log.ts)
  messages: AppMessage[];

  // Subagent lifecycle deltas after spawned only carry subagentId. Keep the
  // spawned metadata here so later updates can replace the full AppTask.
  subagentMeta: Map<string, AppTask>;

  // Bubble cleared by turn.step.retrying, to be reused by the retried
  // step.started (same turn) instead of stacking a new bubble.
  retryReuseMsgId: string | undefined;
}

export function createSessionState(): SessionState {
  return {
    turnPromptId: new Map(),
    currentPromptId: undefined,
    currentAssistantMsgId: undefined,
    turnTextLen: 0,
    turnThinkLen: 0,
    toolStartTimes: new Map(),
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    contextTokens: 0,
    contextLimit: 0,
    turnCount: 0,
    model: '',
    messages: [],
    subagentMeta: new Map(),
    retryReuseMsgId: undefined,
  };
}

// ---------------------------------------------------------------------------
// Usage snapshot builder
// ---------------------------------------------------------------------------

export function buildUsageSnapshot(state: SessionState): AppSessionUsage {
  return {
    inputTokens: state.totalInput,
    outputTokens: state.totalOutput,
    cacheReadTokens: state.totalCacheRead,
    cacheCreationTokens: state.totalCacheCreate,
    totalCostUsd: 0,
    contextTokens: state.contextTokens,
    contextLimit: state.contextLimit,
    turnCount: state.turnCount,
  };
}
