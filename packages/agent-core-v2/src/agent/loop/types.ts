/**
 * `loop` domain (L4) — internal runtime models for the loop service.
 *
 * Mutable turn/step handles, queued turn jobs, held admissions, and the
 * per-run step runtime `loopService` threads through admission, turn
 * pumping, and step execution.
 */

import { createControlledPromise } from '@antfu/utils';

import { type FinishReason } from '#/kosong/contract/provider';

import {
  type LoopRunResult,
  type Step,
  type StepEnqueueOptions,
  type StepResult,
  type Turn,
  type TurnResult,
} from './loop';
import {
  type StepRequest,
  type TurnSeed,
} from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

export type MutableStep = {
  -readonly [K in keyof Step]: Step[K];
} & {
  controller?: AbortController;
  resultControl?: ReturnType<typeof createControlledPromise<StepResult>>;
};

export interface TurnJob {
  readonly request: StepRequest;
  readonly seed: TurnSeed;
  readonly controller: AbortController;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly queue: StepRequestQueue;
  readonly steps: Map<string, MutableStep>;
  readonly turn: MutableTurn;
}

export interface HeldAdmission {
  readonly request: StepRequest;
  readonly options?: StepEnqueueOptions;
}

export interface LoopRuntime {
  readonly turnId: number;
  readonly turnSignal: AbortSignal;
  readonly job: TurnJob | undefined;
  readonly queue: StepRequestQueue;
  steps: number;
  lastStopReason: FinishReason | undefined;
  current: StepRuntime | undefined;
}

export interface StepRuntime {
  readonly number: number;
  readonly uuid: string;
  readonly batch: StepRequestBatch;
  readonly mutableStep: MutableStep | undefined;
  readonly signal: AbortSignal;
}

export type BeginStepResult = { readonly step: StepRuntime } | { readonly result: LoopRunResult };

export type StepExecutionResult = {
  readonly stopReason: FinishReason;
  readonly hookStopTurn: boolean;
};

export type LoopErrorDisposition =
  | { readonly type: 'continue' }
  | { readonly type: 'return'; readonly result: LoopRunResult };
