// apps/kimi-web/src/api/daemon/agentEventProjector.ts
//
// Client-side projector: raw agent-core WS events → AppEvent[]
//
// The real daemon pushes raw agent-core events (NOT the projected "event.*"
// protocol events). This projector translates them into the same AppEvent union
// that the existing reducer (eventReducer.ts) consumes.
//
// Ported from the daemon-side reference implementation:
//   apps/kimi-daemon/src/session/event-projector.ts
//   apps/kimi-daemon/src/session/message-log.ts
//   apps/kimi-daemon/src/session/usage-tracker.ts
//
// Usage:
//   const projector = createAgentProjector();
//   const appEvents = projector.project(rawType, payload, sessionId);
//   // call reset() when re-subscribing / resyncing a session
//
// The projection logic is split across sibling modules:
//   projectorTypes.ts        — public ProjectMeta / AgentProjector contracts
//   projectorHelpers.ts      — shared pure helpers (ulid, usage, field access)
//   projectorState.ts        — per-session state + usage snapshot builder
//   messageLog.ts            — in-memory message log helpers
//   goalSnapshot.ts          — goal.updated snapshot mapping
//   subagentProjection.ts    — subagent task progress projection
//   frameClassifier.ts       — WS frame routing (agent vs protocol)
//   project*Events.ts        — per-event-family projection functions
//   projectRawEvent.ts       — the dispatcher routing raw events to families

import type { AppEvent, AppInFlightTurn } from '../types';
import { cloneMessage, startAssistantMessage } from './messageLog';
import { projectRawEvent } from './projectRawEvent';
import { ulid } from './projectorHelpers';
import { createSessionState, type SessionState } from './projectorState';
import type { AgentProjector, ProjectMeta } from './projectorTypes';

// Public API — kept on this path so existing consumers are unaffected.
export { classifyFrame, isRawAgentCoreEvent } from './frameClassifier';
export type { FrameRoute } from './frameClassifier';
export { subagentProgressText } from './subagentProjection';
export type { AgentProjector, ProjectMeta } from './projectorTypes';

export function createAgentProjector(): AgentProjector {
  const sessions = new Map<string, SessionState>();
  const sideChannelAgents = new Set<string>();

  function getOrCreate(sessionId: string): SessionState {
    let s = sessions.get(sessionId);
    if (!s) {
      s = createSessionState();
      sessions.set(sessionId, s);
    }
    return s;
  }

  function reset(sessionId: string): void {
    sessions.set(sessionId, createSessionState());
  }

  function markSideChannelAgent(agentId: string): void {
    sideChannelAgents.add(agentId);
  }

  function bindNextPromptId(sessionId: string, promptId: string): void {
    const s = getOrCreate(sessionId);
    s.currentPromptId = promptId;
  }

  function seedInFlight(sessionId: string, turn: AppInFlightTurn): AppEvent[] {
    reset(sessionId);
    const s = getOrCreate(sessionId);

    const promptId = turn.promptId ?? ulid('pr_');
    s.currentPromptId = promptId;
    s.turnPromptId.set(turn.turnId, promptId);

    const msg = startAssistantMessage(s, sessionId, promptId);
    if (turn.thinkingText.length > 0) {
      msg.content.push({ type: 'thinking', thinking: turn.thinkingText });
    }
    if (turn.assistantText.length > 0) {
      msg.content.push({ type: 'text', text: turn.assistantText });
    }
    for (const tool of turn.runningTools) {
      const outputLines =
        typeof tool.lastProgress?.text === 'string' && tool.lastProgress.text.length > 0
          ? [tool.lastProgress.text]
          : undefined;
      msg.content.push({
        type: 'toolUse',
        toolCallId: tool.toolCallId,
        toolName: tool.name,
        input: tool.args ?? {},
        outputLines,
      });
      s.toolStartTimes.set(tool.toolCallId, Date.now());
    }
    s.currentAssistantMsgId = msg.id;
    // Seeded step-relative lengths; the next turn.step.started resets both.
    s.turnTextLen = turn.assistantText.length;
    s.turnThinkLen = turn.thinkingText.length;

    return [{ type: 'messageCreated', message: cloneMessage(msg) }];
  }

  function project(
    rawType: string,
    payload: unknown,
    sessionId: string,
    meta?: ProjectMeta,
  ): AppEvent[] {
    try {
      return projectRawEvent(getOrCreate(sessionId), sideChannelAgents, rawType, payload, sessionId, meta);
    } catch (error) {
      // Defensive: log but never crash the caller
      console.error('[agentProjector] Error projecting event:', rawType, error instanceof Error ? error.message : error);
      return [];
    }
  }

  return { project, bindNextPromptId, seedInFlight, reset, markSideChannelAgent };
}
