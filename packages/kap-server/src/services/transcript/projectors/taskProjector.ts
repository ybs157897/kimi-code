/**
 * Background task, shell, and subagent projection.
 *
 * These event families all mutate the same replace-on-upsert task entity, so
 * they share one projector and one task cache. Linking a spawned subagent to
 * its tool frame is delegated to the turn/tool projector through a narrow
 * callback; this module never reaches into frame state directly.
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type {
  AgentRef,
  TranscriptOperation,
  TranscriptTask,
} from '@moonshot-ai/transcript';

type TaskLifecycleEvent =
  | Extract<DomainEvent, { type: 'task.started' }>
  | Extract<DomainEvent, { type: 'task.terminated' }>;
type ShellStartedEvent = Extract<DomainEvent, { type: 'shell.started' }>;
type ShellOutputEvent = Extract<DomainEvent, { type: 'shell.output' }>;
type ShellCompletedEvent = Extract<DomainEvent, { type: 'shell.completed' }>;
type SubagentSpawnedEvent = Extract<DomainEvent, { type: 'subagent.spawned' }>;
type SubagentRunEvent =
  | Extract<DomainEvent, { type: 'subagent.started' }>
  | Extract<DomainEvent, { type: 'subagent.completed' }>
  | Extract<DomainEvent, { type: 'subagent.failed' }>
  | Extract<DomainEvent, { type: 'subagent.suspended' }>;

export type TaskProjectionEvent =
  | TaskLifecycleEvent
  | ShellStartedEvent
  | ShellOutputEvent
  | ShellCompletedEvent
  | SubagentSpawnedEvent
  | SubagentRunEvent;

export type LinkAgentRef = (
  toolCallId: string,
  ref: AgentRef,
) => TranscriptOperation | undefined;

export class TaskProjector {
  private readonly tasks = new Map<string, TranscriptTask>();
  private readonly shellTasks = new Map<string, string>();

  constructor(private readonly linkAgentRef: LinkAgentRef) {}

  project(event: TaskProjectionEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'task.started':
      case 'task.terminated':
        return this.onLifecycle(event);
      case 'shell.started':
        return this.onShellStarted(event);
      case 'shell.output':
        return this.onShellOutput(event);
      case 'shell.completed':
        return this.onShellCompleted(event);
      case 'subagent.spawned':
        return this.onSubagentSpawned(event);
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.suspended':
        return this.onSubagentRun(event);
    }
  }

  private onLifecycle(event: TaskLifecycleEvent): TranscriptOperation[] {
    const { info } = event;
    const infoWithAgent = info as typeof info & { agentId?: string };
    const task = this.upsert(info.taskId, (previous) => ({
      taskId: info.taskId,
      kind: mapTaskKind(info.kind),
      state: info.status,
      detached: info.detached ?? previous?.detached ?? true,
      description: info.description,
      agentId: infoWithAgent.agentId ?? previous?.agentId,
      outputTail: previous?.outputTail ?? '',
      startedAt: previous?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: info.endedAt === null ? previous?.endedAt : epochMsToIso(info.endedAt),
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (event.type === 'task.started') {
      ops.push(taskRef(info.taskId));
    }
    return ops;
  }

  private onShellStarted(event: ShellStartedEvent): TranscriptOperation[] {
    this.shellTasks.set(event.commandId, event.taskId);
    const task = this.upsert(event.taskId, (previous) => ({
      taskId: event.taskId,
      kind: 'shell',
      state: 'running',
      detached: previous?.detached ?? false,
      description: previous?.description,
      agentId: previous?.agentId,
      outputTail: previous?.outputTail ?? '',
      startedAt: previous?.startedAt ?? nowIso(),
      endedAt: previous?.endedAt,
    }));
    return [{ op: 'task.upsert', task }, taskRef(event.taskId)];
  }

  private onShellOutput(event: ShellOutputEvent): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    const text = event.update.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const ops: TranscriptOperation[] = [];
    let task = this.tasks.get(taskId);
    if (task === undefined) {
      task = this.upsert(taskId, (previous) => ({
        taskId,
        kind: 'shell',
        state: 'running',
        detached: previous?.detached ?? false,
        description: previous?.description,
        agentId: previous?.agentId,
        outputTail: previous?.outputTail ?? '',
        startedAt: previous?.startedAt ?? nowIso(),
        endedAt: previous?.endedAt,
      }));
      ops.push({ op: 'task.upsert', task }, taskRef(taskId));
    }
    const offset = task.outputTail.length;
    this.tasks.set(taskId, {
      ...task,
      outputTail: task.outputTail + text,
    });
    ops.push({
      op: 'append',
      target: { type: 'task', taskId },
      offset,
      text,
    });
    return ops;
  }

  private onShellCompleted(event: ShellCompletedEvent): TranscriptOperation[] {
    const taskId = this.shellTaskId(event);
    const hadTask = this.tasks.has(taskId);
    const task = this.upsert(taskId, (previous) => ({
      taskId,
      kind: previous?.kind ?? 'shell',
      state: event.isError ? 'failed' : 'completed',
      detached: previous?.detached ?? false,
      description: previous?.description,
      agentId: previous?.agentId,
      outputTail: previous?.outputTail ?? '',
      startedAt: previous?.startedAt ?? nowIso(),
      endedAt: nowIso(),
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (!hadTask) ops.push(taskRef(taskId));
    return ops;
  }

  private onSubagentSpawned(event: SubagentSpawnedEvent): TranscriptOperation[] {
    const task = this.upsert(event.subagentId, (previous) => ({
      taskId: event.subagentId,
      kind: 'subagent',
      state: 'running',
      detached: event.runInBackground,
      description: event.description ?? previous?.description,
      agentId: event.subagentId,
      outputTail: previous?.outputTail ?? '',
      startedAt: previous?.startedAt ?? nowIso(),
      endedAt: previous?.endedAt,
    }));
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    const link = this.linkAgentRef(event.parentToolCallId, {
      agentId: event.subagentId,
      role: event.swarmIndex !== undefined ? 'member' : 'child',
    });
    if (link !== undefined) ops.push(link);
    return ops;
  }

  private onSubagentRun(event: SubagentRunEvent): TranscriptOperation[] {
    const details = event as SubagentRunEvent & {
      resultSummary?: string;
      usage?: TranscriptTask['usage'];
      error?: string;
      reason?: string;
    };
    const state: TranscriptTask['state'] =
      event.type === 'subagent.completed'
        ? 'completed'
        : event.type === 'subagent.failed'
          ? 'failed'
          : 'running';
    const task = this.upsert(event.subagentId, (previous) => ({
      taskId: event.subagentId,
      kind: 'subagent',
      state,
      detached: previous?.detached ?? true,
      description: previous?.description,
      agentId: event.subagentId,
      outputTail: previous?.outputTail ?? '',
      startedAt: previous?.startedAt ?? nowIso(),
      endedAt:
        event.type === 'subagent.completed' || event.type === 'subagent.failed'
          ? nowIso()
          : previous?.endedAt,
      resultSummary: details.resultSummary ?? previous?.resultSummary,
      usage: details.usage ?? previous?.usage,
      error: details.error ?? previous?.error,
      stateReason: details.reason ?? previous?.stateReason,
    }));
    return [{ op: 'task.upsert', task }];
  }

  private shellTaskId(event: { commandId: string; taskId?: string }): string {
    const taskId =
      this.shellTasks.get(event.commandId) ??
      event.taskId ??
      `shell-${event.commandId}`;
    this.shellTasks.set(event.commandId, taskId);
    return taskId;
  }

  private upsert(
    taskId: string,
    build: (previous: TranscriptTask | undefined) => TranscriptTask,
  ): TranscriptTask {
    const task = build(this.tasks.get(taskId));
    this.tasks.set(taskId, task);
    return task;
  }
}

function taskRef(taskId: string): TranscriptOperation {
  return {
    op: 'taskref.upsert',
    item: {
      kind: 'taskref',
      refId: `ref-${taskId}`,
      taskId,
      at: nowIso(),
    },
  };
}

function mapTaskKind(kind: string): TranscriptTask['kind'] {
  switch (kind) {
    case 'process':
      return 'shell';
    case 'agent':
      return 'subagent';
    default:
      return 'other';
  }
}

function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}
