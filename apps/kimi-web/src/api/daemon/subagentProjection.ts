// apps/kimi-web/src/api/daemon/subagentProjection.ts
// Subagent task projection: patches the subagent AppTask metadata and turns
// subagent-scoped transcript frames into task progress events.

import type { AppEvent, AppTask } from '../types';
import { toolLabel, toolSummary } from '../../lib/toolMeta';
import { stringField } from './projectorHelpers';
import type { SessionState } from './projectorState';

export function patchSubagent(
  state: SessionState,
  sessionId: string,
  subagentId: unknown,
  patch: Partial<AppTask>,
): AppTask | null {
  if (typeof subagentId !== 'string' || subagentId.length === 0) return null;
  const prev = state.subagentMeta.get(subagentId) ?? {
    id: subagentId,
    sessionId,
    kind: 'subagent',
    description: 'Sub Agent',
    status: 'running',
    createdAt: new Date().toISOString(),
    subagentPhase: 'queued',
  } satisfies AppTask;
  const next: AppTask = { ...prev, ...patch, id: subagentId, sessionId, kind: 'subagent' };
  state.subagentMeta.set(subagentId, next);
  return next;
}

export function subagentProgressText(rawType: string, payload: Record<string, unknown>): string | null {
  // "Started a step" fires on every step and adds no information — the phase
  // badge already shows the subagent is working, so skip it to cut the noise.
  if (rawType === 'turn.step.started') return null;
  if (rawType === 'tool.use' || rawType === 'tool.call.started') {
    const name = stringField(payload, 'name') ?? stringField(payload, 'toolName') ?? 'tool';
    const label = toolLabel(cleanToolName(name));
    const summary = toolArgSummary(name, payload['args'] ?? payload['input']);
    return summary ? `Calling ${label}: ${summary}` : `Calling ${label}`;
  }
  if (rawType === 'tool.progress') {
    const update = payload['update'];
    if (update && typeof update === 'object') {
      const text = stringField(update as Record<string, unknown>, 'text');
      if (text) return capProgressText(text);
      const message = stringField(update as Record<string, unknown>, 'message');
      if (message) return capProgressText(message);
    }
    const message = stringField(payload, 'message');
    if (message) return capProgressText(message);
  }
  // tool.result lines ("Finished X") add noise without much information — the
  // next call or the final summary already implies completion — so skip them.
  if (rawType === 'tool.result') return null;
  return null;
}

/** Strip a trailing `_N` index that some subagents append to tool names in
 *  `tool.result` events (e.g. `Read_0` → `Read`) so the label resolves. */
function cleanToolName(name: string): string {
  return name.replace(/_\d+$/, '');
}

/** Cap a progress text chunk so a single huge tool output (e.g. a big command
 *  result) cannot dominate the panel. */
const MAX_PROGRESS_TEXT = 2000;
function capProgressText(text: string): string {
  return text.length > MAX_PROGRESS_TEXT ? `${text.slice(0, MAX_PROGRESS_TEXT)}…` : text;
}

/** A concise, human-readable summary of a tool call's arguments for progress
 *  lines (e.g. a file path or shell command), instead of the full JSON blob. */
function toolArgSummary(name: string, args: unknown): string {
  if (args === undefined || args === null) return '';
  const arg = typeof args === 'string' ? args : JSON.stringify(args);
  return toolSummary(name, arg);
}

export function projectSubagentProgress(
  state: SessionState,
  sessionId: string,
  subagentId: string,
  rawType: string,
  payload: Record<string, unknown>,
  sideChannelAgents: ReadonlySet<string>,
): AppEvent[] {
  // Side-channel agents (e.g. BTW side chat) stream their own transcript via
  // agentDelta events; don't pollute the main task output with generic step
  // placeholders like "Started a step".
  if (sideChannelAgents.has(subagentId) && rawType === 'turn.step.started') return [];

  // The subagent's own streamed text: forward each delta as a `text`-kind
  // progress chunk so the reducer concatenates it into `AppTask.text`, letting
  // the right-side detail panel show the subagent's output growing live (like
  // a thinking block) instead of staying blank until the first tool call.
  if (rawType === 'assistant.delta') {
    const delta = stringField(payload, 'delta');
    if (!delta) return [];
    // Ensure the subagent task exists before forwarding the text delta. A client
    // that subscribed from a snapshot after `subagent.spawned` already fired
    // never received the lifecycle taskCreated, and the reducer only applies
    // taskProgress to existing tasks — without this, the deltas are dropped and
    // the live detail stays blank until a non-text frame recreates the task.
    const previous = state.subagentMeta.get(subagentId);
    const task = patchSubagent(state, sessionId, subagentId, {
      status: 'running',
      subagentPhase: 'working',
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    });
    const out: AppEvent[] = [];
    if (task) out.push({ type: 'taskCreated', sessionId, task });
    out.push({
      type: 'taskProgress',
      sessionId,
      taskId: subagentId,
      outputChunk: delta,
      stream: 'stdout',
      kind: 'text',
    });
    return out;
  }

  const text = subagentProgressText(rawType, payload);
  if (text === null || text.length === 0) return [];
  const previous = state.subagentMeta.get(subagentId);
  const task = patchSubagent(state, sessionId, subagentId, {
    status: 'running',
    subagentPhase: 'working',
    startedAt: previous?.startedAt ?? new Date().toISOString(),
  });
  const out: AppEvent[] = [];
  if (task) out.push({ type: 'taskCreated', sessionId, task });
  out.push({ type: 'taskProgress', sessionId, taskId: subagentId, outputChunk: text, stream: 'stdout' });
  return out;
}
