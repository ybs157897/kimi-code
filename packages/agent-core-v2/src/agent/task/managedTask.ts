/**
 * `task` domain (L5) — the live `ManagedTask` registry entry behind the
 * `AgentTaskService`: the per-task runtime record (status, retained output
 * ring, timers, abort controller, persistence queues), the foreground-release
 * latch (`createForegroundRelease`), and the timeout settlement coercion
 * (`coerceTimeoutSettlement`). Live-only — holds resources that must never be
 * snapshotted into agent state or the wire Model.
 */

import type { ITaskHandle } from '#/app/task/task';
import type {
  AgentTask,
  AgentTaskInfo,
  AgentTaskStatus,
  ForegroundTaskReleaseReason,
  RegisterAgentTaskOptions,
} from './task';
import type { AgentTaskInfoBase, AgentTaskSettlement } from './types';

export interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

export interface ManagedTask {
  readonly taskId: string;
  readonly task: AgentTask | undefined;
  readonly handle: ITaskHandle | undefined;
  readonly toInfoFn?: (base: AgentTaskInfoBase) => AgentTaskInfo;
  readonly forceStopFn?: () => Promise<void>;
  readonly onDetachFn?: () => void;
  readonly outputChunks: string[];
  outputSizeBytes: number;
  retainedOutputBytes: number;
  outputLimitTripped: boolean;
  status: AgentTaskStatus;
  options: RegisterAgentTaskOptions & { description?: string };
  readonly startedAt: number;
  endedAt: number | null;
  foregroundRelease?: ForegroundRelease;
  stopReason?: string;
  terminalNotificationSuppressed?: boolean;
  terminalFired: boolean;
  readonly abortController: AbortController;
  foregroundSignalCleanup?: () => void;
  lifecyclePromise: Promise<void>;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
  pendingOutput: string[];
  pendingOutputBytes: number;
  outputPersistStarted: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  readonly waiters: Array<() => void>;
  handleSubscription?: { dispose(): void };
}

export function coerceTimeoutSettlement(
  entry: ManagedTask,
  settlement: AgentTaskSettlement,
): AgentTaskSettlement {
  if (entry.timedOut && settlement.status === 'killed') {
    return { ...settlement, status: 'timed_out' };
  }
  return settlement;
}

export function createForegroundRelease(): ForegroundRelease {
  let resolve!: (reason: ForegroundTaskReleaseReason) => void;
  const promise = new Promise<ForegroundTaskReleaseReason>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
