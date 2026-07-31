import { z } from 'zod';

import { taskLifecycleStatusSchema, type TaskLifecycleStatus } from './base';
import { cronJobOriginSchema, type CronJobOrigin } from './origin';

export interface TaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: TaskLifecycleStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessTaskInfo extends TaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentTaskInfo extends TaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface QuestionTaskInfo extends TaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type TaskInfo =
  | ProcessTaskInfo
  | AgentTaskInfo
  | QuestionTaskInfo;

export interface TaskStartedEvent {
  readonly type: 'task.started';
  readonly info: TaskInfo;
}

export interface TaskTerminatedEvent {
  readonly type: 'task.terminated';
  readonly info: TaskInfo;
}

/**
 * Legacy background-task lifecycle events emitted by the pre-v2 agent core
 * (`background.task.started` / `background.task.terminated`). The v2 engine
 * emits `task.started` / `task.terminated` instead; both spellings are kept in
 * the union so clients see a consistent event stream across engines.
 */
export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: TaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: TaskInfo;
}

export interface CronFiredEvent {
  readonly type: 'cron.fired';
  readonly origin: CronJobOrigin;
  readonly prompt: string;
}

export const taskInfoBaseSchema = z.object({
  taskId: z.string(),
  description: z.string(),
  status: taskLifecycleStatusSchema,
  detached: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  stopReason: z.string().optional(),
  terminalNotificationSuppressed: z.boolean().optional(),
  timeoutMs: z.number().optional(),
}) satisfies z.ZodType<TaskInfoBase>;

export const processTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('process'),
  command: z.string(),
  pid: z.number(),
  exitCode: z.number().nullable(),
}) satisfies z.ZodType<ProcessTaskInfo>;

export const agentTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('agent'),
  agentId: z.string().optional(),
  subagentType: z.string().optional(),
}) satisfies z.ZodType<AgentTaskInfo>;

export const questionTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('question'),
  questionCount: z.number(),
  toolCallId: z.string().optional(),
}) satisfies z.ZodType<QuestionTaskInfo>;

export const taskInfoSchema = z.discriminatedUnion('kind', [
  processTaskInfoSchema,
  agentTaskInfoSchema,
  questionTaskInfoSchema,
]) satisfies z.ZodType<TaskInfo>;

export const taskStartedEventSchema = z.object({
  type: z.literal('task.started'),
  info: taskInfoSchema,
}) satisfies z.ZodType<TaskStartedEvent>;

export const taskTerminatedEventSchema = z.object({
  type: z.literal('task.terminated'),
  info: taskInfoSchema,
}) satisfies z.ZodType<TaskTerminatedEvent>;

export const backgroundTaskStartedEventSchema = z.object({
  type: z.literal('background.task.started'),
  info: taskInfoSchema,
}) satisfies z.ZodType<BackgroundTaskStartedEvent>;

export const backgroundTaskTerminatedEventSchema = z.object({
  type: z.literal('background.task.terminated'),
  info: taskInfoSchema,
}) satisfies z.ZodType<BackgroundTaskTerminatedEvent>;

export const cronFiredEventSchema = z.object({
  type: z.literal('cron.fired'),
  origin: cronJobOriginSchema,
  prompt: z.string(),
}) satisfies z.ZodType<CronFiredEvent>;
