// apps/kimi-web/src/api/daemon/projectTaskEvents.ts
// Background task raw event projection (e.g. a detached Bash command or a
// background subagent registering under a fresh task id).

import type { AppEvent } from '../types';
import { i18n } from '../../i18n';
import { ulid } from './projectorHelpers';
import type { SessionState } from './projectorState';
import { patchSubagent } from './subagentProjection';

export function projectTaskStarted(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // Tasks (e.g. a detached Bash command). Real daemon shape:
  // payload.info = { taskId, description, status, startedAt(ms), endedAt,
  // kind:'process', command, pid, exitCode }.
  const info = (p?.info ?? {}) as Record<string, unknown>;
  const startedAt =
    typeof info.startedAt === 'number' ? new Date(info.startedAt).toISOString() : undefined;
  const taskId =
    typeof info.taskId === 'string'
      ? info.taskId
      : typeof info.taskId === 'number'
        ? String(info.taskId)
        : ulid('task_');
  const description =
    typeof info.description === 'string'
      ? info.description
      : typeof info.command === 'string'
        ? info.command
        : i18n.global.t('tasks.defaultDescription');
  // A background subagent registers into the background-task store under
  // a fresh task id that differs from its agent id. Record the task id on
  // the existing WS-owned row (keyed by agent id) instead of adding a
  // second row — REST `/tasks` returns the same agent keyed by task id,
  // and keepLiveSubagents folds that copy into this row.
  if (info.kind === 'agent') {
    const agentId =
      typeof info.agentId === 'string' && info.agentId.length > 0
        ? info.agentId
        : undefined;
    if (agentId !== undefined) {
      // Key by agent id even when the spawn event never reached this
      // client (subscribed late): later agent-scoped progress frames are
      // routed by agent id, and seeding subagentMeta here keeps them on
      // this one row instead of synthesizing a second one.
      const task = patchSubagent(s, sessionId, agentId, {
        description,
        backgroundTaskId: taskId,
        runInBackground: true,
      });
      if (task) out.push({ type: 'taskCreated', sessionId, task });
    } else {
      // No agent id — nothing to link; key the row by the background
      // task id so the REST poll dedupes it.
      out.push({
        type: 'taskCreated',
        sessionId,
        task: {
          id: taskId,
          sessionId,
          kind: 'subagent',
          description,
          status: 'running',
          createdAt: startedAt ?? new Date().toISOString(),
          startedAt,
          subagentPhase: 'queued',
          runInBackground: true,
        },
      });
    }
    return out;
  }
  const command = typeof info.command === 'string' ? info.command : undefined;
  out.push({
    type: 'taskCreated',
    sessionId,
    task: {
      id: taskId,
      sessionId,
      kind: 'bash',
      description,
      command,
      status: 'running',
      createdAt: startedAt ?? new Date().toISOString(),
      startedAt,
      outputPreview: command !== undefined ? `$ ${command}` : undefined,
    },
  });
  return out;
}

export function projectTaskTerminated(sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  const info = (p?.info ?? {}) as Record<string, unknown>;
  const failed =
    info.status === 'failed' ||
    (typeof info.exitCode === 'number' && info.exitCode !== 0);
  out.push({
    type: 'taskCompleted',
    sessionId,
    taskId:
      typeof info.taskId === 'string'
        ? info.taskId
        : typeof info.taskId === 'number'
          ? String(info.taskId)
          : '',
    status: failed ? 'failed' : 'completed',
    // Do NOT set outputPreview here. The command is already kept on the
    // task as `command`; setting outputPreview to `$ <command>` would
    // clobber any real output captured by polling and prevents the UI
    // from fetching the final terminal output after the task finishes.
  });
  return out;
}
