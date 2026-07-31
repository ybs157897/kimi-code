// apps/kimi-web/src/api/daemon/projectSubagentEvents.ts
// Subagent lifecycle raw event projection: spawned / started / suspended /
// completed / failed → taskCreated / taskCompleted events.

import type { AppEvent, AppTask } from '../types';
import { ulid } from './projectorHelpers';
import type { SessionState } from './projectorState';
import { patchSubagent } from './subagentProjection';

export function projectSubagentSpawned(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const taskId = typeof p?.subagentId === 'string' && p.subagentId.length > 0 ? p.subagentId : ulid('task_');
  const task: AppTask = {
    id: taskId,
    sessionId,
    kind: 'subagent',
    description: typeof p?.description === 'string' ? p.description : p?.subagentName ?? 'Sub Agent',
    status: 'running',
    createdAt: new Date().toISOString(),
    subagentPhase: 'queued',
    subagentType: typeof p?.subagentName === 'string' ? p.subagentName : undefined,
    parentToolCallId: typeof p?.parentToolCallId === 'string' ? p.parentToolCallId : undefined,
    swarmIndex: typeof p?.swarmIndex === 'number' ? p.swarmIndex : undefined,
    runInBackground: p?.runInBackground === true,
  };
  s.subagentMeta.set(task.id, task);
  out.push({
    type: 'taskCreated',
    sessionId,
    task,
  });
  return out;
}

export function projectSubagentStarted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const task = patchSubagent(s, sessionId, p?.subagentId, {
    subagentPhase: 'working',
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  if (task) out.push({ type: 'taskCreated', sessionId, task });
  return out;
}

export function projectSubagentSuspended(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const task = patchSubagent(s, sessionId, p?.subagentId, {
    subagentPhase: 'suspended',
    status: 'running',
    suspendedReason: typeof p?.reason === 'string' ? p.reason : undefined,
  });
  if (task) out.push({ type: 'taskCreated', sessionId, task });
  return out;
}

export function projectSubagentCompleted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const outputPreview = typeof p?.resultSummary === 'string' ? p.resultSummary : undefined;
  const task = patchSubagent(s, sessionId, p?.subagentId, {
    subagentPhase: 'completed',
    status: 'completed',
    completedAt: new Date().toISOString(),
    outputPreview,
  });
  if (task) out.push({ type: 'taskCreated', sessionId, task });
  out.push({
    type: 'taskCompleted',
    sessionId,
    taskId: p?.subagentId ?? '',
    status: 'completed',
    outputPreview,
  });
  return out;
}

export function projectSubagentFailed(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const outputPreview = typeof p?.error === 'string' ? p.error : undefined;
  const task = patchSubagent(s, sessionId, p?.subagentId, {
    subagentPhase: 'failed',
    status: 'failed',
    completedAt: new Date().toISOString(),
    outputPreview,
  });
  if (task) out.push({ type: 'taskCreated', sessionId, task });
  out.push({
    type: 'taskCompleted',
    sessionId,
    taskId: p?.subagentId ?? '',
    status: 'failed',
    outputPreview,
  });
  return out;
}
