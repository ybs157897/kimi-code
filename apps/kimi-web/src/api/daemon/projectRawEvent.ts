// apps/kimi-web/src/api/daemon/projectRawEvent.ts
// Dispatcher: routes one raw agent-core event to its per-family projection
// function. Subagent-scoped transcript frames are diverted to the subagent
// task-progress path before the switch.

import type { AppEvent } from '../types';
import { projectCompactionCancelled, projectCompactionCompleted, projectCompactionStarted } from './projectCompactionEvents';
import { projectAssistantDelta, projectThinkingDelta } from './projectDeltaEvents';
import { projectAgentError, projectAgentWarning, projectCronFired, projectGoalUpdated } from './projectMiscEvents';
import { projectPromptAborted, projectPromptCompleted, projectPromptSubmitted } from './projectPromptEvents';
import { projectAgentStatusUpdated, projectSessionMetaUpdated } from './projectSessionEvents';
import { projectSubagentCompleted, projectSubagentFailed, projectSubagentSpawned, projectSubagentStarted, projectSubagentSuspended } from './projectSubagentEvents';
import { projectTaskStarted, projectTaskTerminated } from './projectTaskEvents';
import { projectToolCallStarted, projectToolProgress, projectToolResult } from './projectToolEvents';
import {
  projectTurnEnded,
  projectTurnStarted,
  projectTurnStepCompleted,
  projectTurnStepInterrupted,
  projectTurnStepRetrying,
  projectTurnStepStarted,
} from './projectTurnEvents';
import type { SessionState } from './projectorState';
import type { ProjectMeta } from './projectorTypes';
import { projectSubagentProgress } from './subagentProjection';

// Subagent turns share the parent session id: their turn / step / delta / tool
// frames stream over the SAME session channel, each tagged with the subagent's
// own agentId (the main agent's is 'main'). They must NOT be folded into the
// parent transcript — doing so created empty "skeleton" assistant bubbles (a
// subagent turn.step.started opens a parent assistant message that never gets
// the main agent's text) and fragmented snippets (subagent deltas appended to
// the parent). The subagent's live progress is surfaced separately via the
// subagent.* → task → right-side detail panel path (the spawning `Agent` tool
// itself renders as a normal tool card in the transcript). This mirrors the
// server's InFlightTurnTracker, which likewise tracks only main-agent activity.
const MAIN_AGENT_ID = 'main';
const MAIN_AGENT_TRANSCRIPT_FRAMES = new Set<string>([
  'turn.started',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'turn.ended',
  'thinking.delta',
  'assistant.delta',
  'tool.use',
  'tool.call.started',
  'tool.call.delta',
  'tool.progress',
  'tool.result',
  'agent.status.updated',
  'prompt.completed',
  'prompt.aborted',
  'error',
]);

export function projectRawEvent(
  s: SessionState,
  sideChannelAgents: ReadonlySet<string>,
  rawType: string,
  payload: unknown,
  sessionId: string,
  meta?: ProjectMeta,
): AppEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  const out: AppEvent[] = [];

  // Drop subagent-scoped transcript frames (see MAIN_AGENT_TRANSCRIPT_FRAMES).
  // A subagent carries its own agentId; only the main agent's stream builds the
  // visible transcript. Lifecycle frames (subagent.*, goal.*, background.*) are
  // intentionally NOT in the set — they describe the subagent for the task view
  // and must always be projected.
  const frameAgentId: unknown = p?.agentId;
  if (typeof frameAgentId === 'string' && frameAgentId !== MAIN_AGENT_ID) {
    const isSideChannel = sideChannelAgents.has(frameAgentId);
    // Side-channel agents (e.g. BTW side chat) stream text/thinking deltas and
    // a turn boundary over the parent session channel. Route them to the web
    // layer as agent-scoped events instead of dropping them or folding them
    // into the parent transcript.
    if (isSideChannel && (rawType === 'thinking.delta' || rawType === 'assistant.delta')) {
      const deltaText: string = p?.delta ?? '';
      if (!deltaText) return [];
      return [
        {
          type: 'agentDelta' as const,
          sessionId,
          agentId: frameAgentId,
          delta: { [rawType === 'thinking.delta' ? ('thinking' as const) : ('text' as const)]: deltaText },
        },
      ];
    }
    if (isSideChannel && rawType === 'turn.ended') {
      return [
        { type: 'agentTurnEnded' as const, sessionId, agentId: frameAgentId, reason: p?.reason },
      ];
    }
    if (MAIN_AGENT_TRANSCRIPT_FRAMES.has(rawType)) {
      return projectSubagentProgress(s, sessionId, frameAgentId, rawType, p ?? {}, sideChannelAgents);
    }
  }

  switch (rawType) {
    // -----------------------------------------------------------------------
    case 'session.meta.updated':
      return projectSessionMetaUpdated(sessionId, p);

    // -----------------------------------------------------------------------
    case 'prompt.submitted':
      return projectPromptSubmitted(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'turn.started':
      return projectTurnStarted(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'turn.step.started':
      return projectTurnStepStarted(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'thinking.delta':
      return projectThinkingDelta(s, sessionId, p, meta);

    // -----------------------------------------------------------------------
    case 'assistant.delta':
      return projectAssistantDelta(s, sessionId, p, meta);

    // -----------------------------------------------------------------------
    case 'tool.use':
    case 'tool.call.started':
      return projectToolCallStarted(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'tool.call.delta': {
      // Input streaming — no-op for the web client (content already in tool.call.started.args)
      break;
    }

    // -----------------------------------------------------------------------
    case 'tool.progress':
      return projectToolProgress(sessionId, p);

    // -----------------------------------------------------------------------
    case 'tool.result':
      return projectToolResult(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'turn.step.completed':
      return projectTurnStepCompleted(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'agent.status.updated':
      return projectAgentStatusUpdated(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'turn.ended':
      return projectTurnEnded(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'prompt.completed':
      return projectPromptCompleted(sessionId, p);

    // -----------------------------------------------------------------------
    case 'prompt.aborted':
      return projectPromptAborted(sessionId, p);

    // -----------------------------------------------------------------------
    case 'turn.step.retrying':
      return projectTurnStepRetrying(s, sessionId);

    case 'turn.step.interrupted':
      return projectTurnStepInterrupted(s);

    // -----------------------------------------------------------------------
    case 'subagent.spawned':
      return projectSubagentSpawned(s, sessionId, p);

    case 'subagent.started':
      return projectSubagentStarted(s, sessionId, p);

    case 'subagent.suspended':
      return projectSubagentSuspended(s, sessionId, p);

    case 'subagent.completed':
      return projectSubagentCompleted(s, sessionId, p);

    case 'subagent.failed':
      return projectSubagentFailed(s, sessionId, p);

    // -----------------------------------------------------------------------
    case 'error':
      return projectAgentError(p);

    case 'warning':
      return projectAgentWarning(p);

    // -----------------------------------------------------------------------
    case 'task.started':
      return projectTaskStarted(s, sessionId, p);

    case 'task.terminated':
      return projectTaskTerminated(sessionId, p);

    // -----------------------------------------------------------------------
    case 'compaction.completed':
      return projectCompactionCompleted(sessionId, p);

    case 'compaction.started':
      return projectCompactionStarted(sessionId, p);

    case 'compaction.cancelled':
      return projectCompactionCancelled(sessionId);

    case 'goal.updated':
      return projectGoalUpdated(sessionId, p);

    // -----------------------------------------------------------------------
    case 'cron.fired':
      return projectCronFired(s, sessionId, p);

    // -----------------------------------------------------------------------
    // Explicitly known but not projected
    case 'compaction.blocked':
    case 'hook.result':
    case 'mcp.server.status':
    case 'skill.activated':
    case 'tool.list.updated':
      break;

    // -----------------------------------------------------------------------
    default:
      // Unknown future events — safe no-op
      break;
  }

  return out;
}
