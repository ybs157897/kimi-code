/**
 * Turn/tool stream projection for one agent.
 *
 * This is the only projector that owns timeline-local streaming state:
 * current turn/step, open text frames, tool frames, and accumulated usage.
 * Other engine event families are routed by `coreEventMap` to their own
 * replace-on-upsert read-model owners.
 *
 * Mapping rules:
 *   - `turn.upsert` / `step.upsert` carry headers only; render content rides
 *     on `frame.upsert` (whole frame state) and `append` (deltas).
 *   - The turn prompt arrives on `turn.started` itself
 *     (`TurnStartedEvent.prompt`) — the context append carrying the same text
 *     is not a bus event and lands after the turn header.
 *   - Flush: at step/turn completion boundaries every open text/thinking frame
 *     of that step is re-emitted as a full-text `frame.upsert` — this is how
 *     'block'-grade subscribers (who never see `append`) reconverge.
 *   - `tool.call.delta` accumulates the raw argument text into the tool
 *     frame's `inputText` (creating the frame when the delta arrives before
 *     `tool.call.started`, which then keeps it); `tool.progress` overwrites
 *     the frame's `progress` with the newest update.
 *   - Step headers carry the LLM accounting: `turn.step.completed` fills
 *     `usage` (the wire `TokenUsage` verbatim), `finishReason`
 *     (`finishReason ?? rawFinishReason ?? providerFinishReason`) and the
 *     full `timing` breakdown; `turn.step.retrying` sets `retry` on the still
 *     'running' step (the terminal upsert carries no `retry`, which clears
 *     it); `turn.step.interrupted` fills `endReason` / `endMessage`.
 *   - `turn.ended` fills the turn header's `durationMs` / `error` plus the
 *     accumulated `usage`: the projector sums this turn's step usages
 *     (`inputTokens = inputOther + inputCacheCreation`,
 *     `cachedTokens = inputCacheRead`, `outputTokens = output`); a turn whose
 *     steps reported no usage gets no `usage`.
 * `task.notified` remains here because placing the notification requires the
 * current open turn and step. Task entity lifecycle itself lives in
 * TaskProjector.
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type {
  AgentRef,
  StepHeader,
  StepUsage,
  TextFrame,
  ToolCallFrame,
  ToolFrameProgress,
  TranscriptFrame,
  TranscriptOperation,
  TranscriptTodo,
  TranscriptUsage,
  TurnHeader,
  TurnOrigin,
  TurnState,
} from '@moonshot-ai/transcript';

export type TurnToolProjectionEvent = Extract<
  DomainEvent,
  {
    type:
      | 'turn.started'
      | 'turn.ended'
      | 'turn.step.started'
      | 'turn.step.completed'
      | 'turn.step.interrupted'
      | 'turn.step.retrying'
      | 'assistant.delta'
      | 'thinking.delta'
      | 'tool.call.delta'
      | 'tool.progress'
      | 'tool.call.started'
      | 'tool.result'
      | 'task.notified';
  }
>;

/**
 * Read access to one step's current frames (the producer store). Used for
 * mid-stream attach adoption — see `adoptStreamFrame`.
 */
export type ProjectorFrameLookup = (
  turnId: string,
  stepId: string,
) => readonly TranscriptFrame[] | undefined;

/**
 * Locate a tool frame by its toolCallId across the producer store. Used for
 * mid-bind result adoption — see `adoptToolFrame`.
 */
export type ProjectorToolFrameLookup = (toolCallId: string) => ToolFrameRecord | undefined;

/**
 * The engine-reported current step ordinal for a turn (the activity view).
 * Used to place deltas correctly when the projector attached after
 * `turn.step.started` for a later step — see `ensureStep`.
 */
export type ProjectorStepOrdinalLookup = (turnId: string) => number | undefined;

/** Optional producer-store lookups that let the projector adopt seeded state. */
export interface ProjectorLookups {
  readonly stepFrames?: ProjectorFrameLookup;
  readonly toolFrame?: ProjectorToolFrameLookup;
  readonly stepOrdinal?: ProjectorStepOrdinalLookup;
}

interface OpenTextFrame {
  readonly frameId: string;
  offset: number;
  text: string;
}

export interface ToolFrameRecord {
  readonly turnId: string;
  readonly stepId: string;
  readonly frame: ToolCallFrame;
}

export class TurnToolProjector {
  /** Latest header of the in-flight (or most recent) turn; kept whole so terminal upserts preserve `origin` / `startedAt` by reference. */
  private currentTurn: TurnHeader | undefined;
  private currentStep: StepHeader | undefined;
  /** turnId → highest step ordinal seen (engine-reported placement hint). */
  private readonly stepOrdinals = new Map<string, number>();
  private frameOrdinal = 0;
  private openText: OpenTextFrame | undefined;
  private openThinking: OpenTextFrame | undefined;
  private readonly toolFrames = new Map<string, ToolFrameRecord>();
  /** turnId → step usages reported so far; folded into the turn header at `turn.ended`. */
  private readonly stepUsageByTurn = new Map<string, StepUsage[]>();
  constructor(
    readonly agentId: string,
    private readonly lookups?: ProjectorLookups,
  ) {}

  project(event: TurnToolProjectionEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'turn.started':
        return this.onTurnStarted(event);
      case 'turn.ended':
        return this.onTurnEnded(event);
      case 'turn.step.started':
        return this.onStepStarted(event);
      case 'turn.step.completed':
        return this.onStepCompleted(event);
      case 'turn.step.interrupted':
        return this.onStepFinished(event);
      case 'turn.step.retrying':
        return this.onStepRetrying(event);
      case 'assistant.delta':
        return this.onTextDelta(event.turnId, 'assistant', event.delta);
      case 'thinking.delta':
        return this.onTextDelta(event.turnId, 'thinking', event.delta);
      case 'tool.call.delta':
        return this.onToolCallDelta(event);
      case 'tool.progress':
        return this.onToolProgress(event);
      case 'tool.call.started':
        return this.onToolCallStarted(event);
      case 'tool.result':
        return this.onToolResult(event);
      case 'task.notified':
        return this.onTaskNotified(event);
    }
  }

  // ---------------------------------------------------------------- turn / step

  private onTurnStarted(event: {
    turnId: number;
    origin: unknown;
    prompt?: string;
  }): TranscriptOperation[] {
    const n = event.turnId;
    const turnId = `t${n}`;
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: n,
      state: 'running',
      origin: mapTurnOrigin(event.origin),
      prompt: event.prompt,
      startedAt: nowIso(),
    };
    this.currentStep = undefined;
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: 'turn.upsert', turn: this.currentTurn }];
  }

  private onTurnEnded(event: {
    turnId: number;
    reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    error?: { message: string };
    durationMs?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    // Defensive: a step left running is closed with the turn (the normal path
    // closes it via `turn.step.completed` / `turn.step.interrupted` first).
    if (this.currentStep !== undefined && this.currentStep.state === 'running') {
      const step: StepHeader = { ...this.currentStep, state: 'interrupted', endedAt: nowIso() };
      this.currentStep = step;
      ops.push({ op: 'step.upsert', turnId: step.turnId, step });
    }
    const prev = this.currentTurn?.turnId === turnId ? this.currentTurn : undefined;
    const state = mapTurnEndState(event.reason);
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: event.turnId,
      state,
      origin: prev?.origin ?? { kind: 'other' },
      prompt: prev?.prompt,
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      durationMs: event.durationMs,
      error: event.error?.message,
      usage: this.takeTurnUsage(turnId),
    };
    ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    this.currentStep = undefined;
    return ops;
  }

  /**
   * Fold this turn's accumulated step usages into the turn header's
   * `TranscriptUsage` and drop the accumulator. Step usages are the engine's
   * four-component `TokenUsage`; the header maps them to the render vocabulary
   * (`inputTokens = inputOther + inputCacheCreation`,
   * `cachedTokens = inputCacheRead`, `outputTokens = output`). A turn whose
   * steps all reported no usage gets no `usage` at all (the components have
   * no data either way — the wire never omits a single component).
   */
  private takeTurnUsage(turnId: string): TranscriptUsage | undefined {
    const usages = this.stepUsageByTurn.get(turnId);
    this.stepUsageByTurn.delete(turnId);
    if (usages === undefined || usages.length === 0) return undefined;
    let inputOther = 0;
    let output = 0;
    let inputCacheRead = 0;
    let inputCacheCreation = 0;
    for (const usage of usages) {
      inputOther += usage.inputOther;
      output += usage.output;
      inputCacheRead += usage.inputCacheRead;
      inputCacheCreation += usage.inputCacheCreation;
    }
    return {
      inputTokens: inputOther + inputCacheCreation,
      cachedTokens: inputCacheRead,
      outputTokens: output,
    };
  }

  private onStepStarted(event: { turnId: number; step: number }): TranscriptOperation[] {
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    this.stepOrdinals.set(turnId, event.step);
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: nowIso(),
    };
    this.frameOrdinal = 0;
    // Stray open frames from an interrupted previous step are dropped without
    // a flush — their step's own completion event owns the flush.
    this.openText = undefined;
    this.openThinking = undefined;
    return [{ op: 'step.upsert', turnId, step: this.currentStep }];
  }

  private onStepCompleted(event: {
    turnId: number;
    step: number;
    usage?: StepUsage;
    finishReason?: string;
    rawFinishReason?: string;
    providerFinishReason?: string;
    llmFirstTokenLatencyMs?: number;
    llmStreamDurationMs?: number;
    llmRequestBuildMs?: number;
    llmServerFirstTokenMs?: number;
    llmServerDecodeMs?: number;
    llmClientConsumeMs?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    if (event.usage !== undefined) {
      const usages = this.stepUsageByTurn.get(turnId) ?? [];
      usages.push(event.usage);
      this.stepUsageByTurn.set(turnId, usages);
    }
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'completed',
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      usage: event.usage,
      finishReason: event.finishReason ?? event.rawFinishReason ?? event.providerFinishReason,
      // The header always carries the timing object; the wire omits the
      // latency fields it never measured, which land as absent keys.
      timing: {
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        llmRequestBuildMs: event.llmRequestBuildMs,
        llmServerFirstTokenMs: event.llmServerFirstTokenMs,
        llmServerDecodeMs: event.llmServerDecodeMs,
        llmClientConsumeMs: event.llmClientConsumeMs,
      },
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  private onStepFinished(event: {
    type: 'turn.step.interrupted';
    turnId: number;
    step: number;
    reason: string;
    message?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushOpenFrames(ops);
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'interrupted',
      startedAt: prev?.startedAt,
      endedAt: nowIso(),
      endReason: event.reason,
      endMessage: event.message,
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  /**
   * `turn.step.retrying` — a claimed provider failure is being retried on the
   * same step. The step stays 'running' with the retry detail on the header;
   * the terminal step upsert simply carries no `retry`, which clears it
   * (step.upsert replaces the whole header).
   */
  private onStepRetrying(event: {
    turnId: number;
    step: number;
    failedAttempt: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    errorName: string;
    errorMessage: string;
    statusCode?: number;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const stepId = `${turnId}.${event.step}`;
    const prev = this.currentStep?.stepId === stepId ? this.currentStep : undefined;
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: prev?.startedAt,
      retry: {
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      },
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  private onTextDelta(
    turnNumber: number,
    kind: 'assistant' | 'thinking',
    delta: string,
  ): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${turnNumber}`;
    const step = this.ensureStep(turnId, ops);
    let open = kind === 'assistant' ? this.openText : this.openThinking;
    // Mid-stream attach: the backfill may have seeded this step's stream
    // frame already — adopt it instead of opening an empty one.
    open ??= this.adoptStreamFrame(turnId, step.stepId, kind);
    if (open === undefined) {
      const frameId = `${step.stepId}.f${++this.frameOrdinal}`;
      open = { frameId, offset: 0, text: '' };
      ops.push({
        op: 'frame.upsert',
        turnId,
        stepId: step.stepId,
        frame:
          kind === 'assistant'
            ? { kind: 'text', frameId, role: 'assistant', text: '' }
            : { kind: 'thinking', frameId, text: '' },
      });
    }
    // Known limitation: one open text frame per step per stream kind — if the
    // model emits multiple disjoint text parts in one step they are
    // concatenated into the single frame (the wire `assistant.delta` stream is
    // cumulative per turn and carries no part boundary).
    ops.push({
      op: 'append',
      target: { type: 'frame', turnId, stepId: step.stepId, frameId: open.frameId },
      offset: open.offset,
      text: delta,
    });
    open.offset += delta.length;
    open.text += delta;
    if (kind === 'assistant') this.openText = open;
    else this.openThinking = open;
    return ops;
  }

  /**
   * Mid-stream attach adoption. When the projector starts streaming a step it
   * has never seen, the history backfill may already have seeded that step's
   * stream frame with the text persisted so far (the in-flight turn's deltas
   * are persisted upstream). Opening a fresh frame here would emit an empty
   * `frame.upsert` that clobbers the seeded text, followed by offset-0
   * appends that cannot land past it — corrupting the live transcript until
   * the next cold rebuild. Instead adopt the seeded frame: continue its id
   * and offset (the persisted text is a prefix of the same stream), and
   * advance `frameOrdinal` past the step's existing `.fN` frames so later
   * frames cannot collide. Known limitation: deltas observed between bind
   * and the backfill landing still open a fresh frame (the backfill's later
   * upsert then replaces it wholesale).
   */
  private adoptStreamFrame(
    turnId: string,
    stepId: string,
    kind: 'assistant' | 'thinking',
  ): OpenTextFrame | undefined {
    const frames = this.lookups?.stepFrames?.(turnId, stepId);
    if (frames === undefined || frames.length === 0) return undefined;
    for (const frame of frames) {
      const match = /\.f(\d+)$/.exec(frame.frameId);
      if (match !== null) {
        this.frameOrdinal = Math.max(this.frameOrdinal, Number(match[1]));
      }
    }
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (frame === undefined) continue;
      if (kind === 'assistant' && frame.kind === 'text' && frame.role === 'assistant') {
        return { frameId: frame.frameId, offset: frame.text.length, text: frame.text };
      }
      if (kind === 'thinking' && frame.kind === 'thinking') {
        return { frameId: frame.frameId, offset: frame.text.length, text: frame.text };
      }
    }
    return undefined;
  }

  /** Re-emit every open text/thinking frame with its full text (the 'block'-grade convergence point). */
  private flushOpenFrames(ops: TranscriptOperation[]): void {
    const step = this.currentStep;
    for (const open of [this.openText, this.openThinking]) {
      if (open === undefined || step === undefined) continue;
      const isText = open === this.openText;
      ops.push({
        op: 'frame.upsert',
        turnId: step.turnId,
        stepId: step.stepId,
        frame: isText
          ? { kind: 'text', frameId: open.frameId, role: 'assistant', text: open.text }
          : { kind: 'thinking', frameId: open.frameId, text: open.text },
      });
    }
    this.openText = undefined;
    this.openThinking = undefined;
  }

  /**
   * Resolve the step a content event belongs to. When the projector missed
   * `turn.step.started` (mid-stream attach), prefer the engine-reported
   * active step from the activity view; then the latest step this projector
   * saw; only then the `t<N>.1` fallback (the store skeleton-fills anything
   * still missing). Without the lookup a late attach at step ≥ 2 would
   * stream into the wrong step.
   */
  private ensureStep(turnId: string, ops: TranscriptOperation[]): StepHeader {
    if (this.currentStep !== undefined && this.currentStep.turnId === turnId) {
      return this.currentStep;
    }
    const ordinal =
      this.lookups?.stepOrdinal?.(turnId) ?? this.stepOrdinals.get(turnId) ?? 1;
    this.currentStep = {
      kind: 'step',
      stepId: `${turnId}.${ordinal}`,
      turnId,
      ordinal,
      state: 'running',
      startedAt: nowIso(),
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return this.currentStep;
  }

  // ---------------------------------------------------------------- tools

  /**
   * `tool.call.delta` — raw argument streaming. The deltas accumulate into the
   * frame's `inputText` (the verbatim counterpart of the parsed `input`). A
   * delta can arrive before `tool.call.started` (the stream reports arguments
   * as they generate): the frame is then created here, and the later started
   * event fills in name/input/display while keeping the accumulated text.
   */
  private onToolCallDelta(event: {
    turnId: number;
    toolCallId: string;
    name?: string;
    argumentsPart?: string;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const prev = this.toolFrames.get(event.toolCallId);
    if (prev !== undefined) {
      const frame: ToolCallFrame = {
        ...prev.frame,
        inputText: (prev.frame.inputText ?? '') + (event.argumentsPart ?? ''),
      };
      this.toolFrames.set(event.toolCallId, { ...prev, frame });
      ops.push({ op: 'frame.upsert', turnId: prev.turnId, stepId: prev.stepId, frame });
      return ops;
    }
    const turnId = `t${event.turnId}`;
    const step = this.ensureStep(turnId, ops);
    const frameId = `${step.stepId}.${event.toolCallId}`;
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId,
      toolCallId: event.toolCallId,
      // The delta's name is optional (some providers stream arguments before
      // naming the call); the empty string converges at `tool.call.started`.
      name: event.name ?? '',
      state: 'running',
      inputText: event.argumentsPart ?? '',
    };
    this.toolFrames.set(event.toolCallId, { turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  /**
   * `tool.progress` — the newest execution update overwrites the frame's
   * `progress` (whole-frame upsert, as for every tool frame mutation).
   */
  private onToolProgress(event: {
    toolCallId: string;
    update: ToolFrameProgress;
  }): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId) ?? this.adoptToolFrame(event.toolCallId);
    // No frame to hang the update on (the attach raced the call and the
    // backfill has not landed either) — drop it; the terminal `tool.result`
    // still converges the frame.
    if (hit === undefined) return [];
    const frame: ToolCallFrame = {
      ...hit.frame,
      progress: {
        kind: event.update.kind,
        text: event.update.text,
        percent: event.update.percent,
        customKind: event.update.customKind,
        customData: event.update.customData,
      },
    };
    this.toolFrames.set(event.toolCallId, { ...hit, frame });
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame }];
  }

  private onToolCallStarted(event: {
    turnId: number;
    toolCallId: string;
    name: string;
    args: unknown;
    display?: unknown;
  }): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const step = this.ensureStep(turnId, ops);
    const frameId = `${step.stepId}.${event.toolCallId}`;
    const input = parseToolArgs(event.args);
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId,
      toolCallId: event.toolCallId,
      name: event.name,
      state: 'running',
      input,
      // Argument text accumulated from `tool.call.delta` before this event.
      inputText: this.toolFrames.get(event.toolCallId)?.frame.inputText,
      display: event.display,
      todoId: event.name === TODO_LIST_TOOL_NAME && todoWriteItems(input) !== undefined ? TODO_ENTITY_ID : undefined,
    };
    this.toolFrames.set(event.toolCallId, { turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  private onToolResult(event: {
    toolCallId: string;
    output: unknown;
    isError?: boolean;
  }): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId) ?? this.adoptToolFrame(event.toolCallId);
    if (hit === undefined) return [];
    const isError = event.isError === true;
    const frame: ToolCallFrame = {
      ...hit.frame,
      state: isError ? 'error' : 'done',
      output: event.output,
      error: isError && typeof event.output === 'string' ? event.output : undefined,
    };
    this.toolFrames.set(event.toolCallId, { ...hit, frame });
    const ops: TranscriptOperation[] = [
      { op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame },
    ];
    // A confirmed TodoList write replaces the global todo document (the frame
    // keeps its own point-in-time snapshot in `display`).
    if (!isError && frame.name === TODO_LIST_TOOL_NAME) {
      const items = todoWriteItems(frame.input);
      if (items !== undefined) {
        const todo: TranscriptTodo = { todoId: TODO_ENTITY_ID, items, updatedAt: nowIso() };
        ops.push({ op: 'todo.upsert', todo });
      }
    }
    return ops;
  }

  /**
   * Mid-bind adoption: the transcript may have attached after `tool.call.started`
   * (the backfill seeded the frame from the persisted assistant toolCalls) but
   * before `tool.result`. This projector's map is empty then and the result
   * would be dropped; adopt the seeded frame so the result lands where a live
   * observer put it.
   */
  private adoptToolFrame(toolCallId: string): ToolFrameRecord | undefined {
    const hit = this.lookups?.toolFrame?.(toolCallId);
    if (hit === undefined) return undefined;
    this.toolFrames.set(toolCallId, hit);
    return hit;
  }

  /**
   * Narrow task → frame integration: TaskProjector owns subagent entities,
   * while this projector owns tool frames. A spawn only asks this owner to
   * attach an AgentRef; it never reads or mutates frame state itself.
   */
  linkAgentRef(toolCallId: string, ref: AgentRef): TranscriptOperation | undefined {
    const hit = this.toolFrames.get(toolCallId) ?? this.adoptToolFrame(toolCallId);
    if (hit === undefined) return undefined;
    const frame: ToolCallFrame = {
      ...hit.frame,
      agentRefs: [...(hit.frame.agentRefs ?? []), ref],
    };
    this.toolFrames.set(toolCallId, { ...hit, frame });
    return {
      op: 'frame.upsert',
      turnId: hit.turnId,
      stepId: hit.stepId,
      frame,
    };
  }

  linkApproval(
    toolCallId: string,
    interactionId: string,
  ): TranscriptOperation | undefined {
    const hit = this.toolFrames.get(toolCallId) ?? this.adoptToolFrame(toolCallId);
    if (hit === undefined) return undefined;
    const frame: ToolCallFrame = {
      ...hit.frame,
      approvalId: interactionId,
    };
    this.toolFrames.set(toolCallId, { ...hit, frame });
    return {
      op: 'frame.upsert',
      turnId: hit.turnId,
      stepId: hit.stepId,
      frame,
    };
  }

  // ---------------------------------------------------------------- tasks

  /**
   * `task.notified` — a background task's completion notification. Mid-turn
   * the engine injects the notification message into the running turn's
   * context, so it surfaces as a user input frame inside the open step,
   * linked to the task entity (`text.taskId`). When no step is open the
   * notification opens a fresh turn with `origin.kind === 'task'` instead
   * (the `turn.started` path owns that case).
   */
  private onTaskNotified(event: {
    notificationType: string;
    title: string;
    body: string;
    severity: string;
    sourceKind: string;
    sourceId: string;
  }): TranscriptOperation[] {
    const step = this.currentStep;
    const turn = this.currentTurn;
    const midTurn =
      step !== undefined &&
      turn !== undefined &&
      step.state === 'running' &&
      turn.state === 'running';
    if (!midTurn) return [];
    const frame: TextFrame = {
      kind: 'text',
      frameId: `${step.stepId}.f${++this.frameOrdinal}`,
      role: 'user',
      text: `${event.title}\n${event.body}`.trim(),
      taskId: event.sourceId,
    };
    return [{ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame }];
  }

}

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Engine `PromptOrigin` → transcript `TurnOrigin` (mirrors the cold-path
 * `groupMessagesIntoSnapshot` origin mapping; payload kept verbatim).
 */
function mapTurnOrigin(origin: unknown): TurnOrigin {
  const candidate = origin as { kind?: unknown } | null | undefined;
  const kind = typeof candidate?.kind === 'string' ? candidate.kind : undefined;
  if (kind === undefined) return { kind: 'other', payload: origin };
  switch (kind) {
    case 'user':
      return { kind: 'user', payload: origin };
    case 'cron_job':
    case 'cron_missed': {
      const jobId = (candidate as { jobId?: unknown }).jobId;
      return {
        kind: 'cron',
        taskId: typeof jobId === 'string' ? jobId : undefined,
        payload: origin,
      };
    }
    case 'task':
    case 'background_task': {
      const taskId = (candidate as { taskId?: unknown }).taskId;
      return typeof taskId === 'string'
        ? { kind: 'task', taskId, payload: origin }
        : { kind: 'other', payload: origin };
    }
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'compaction_summary':
      return { kind: 'compaction', payload: origin };
    case 'shell_command':
      // `!shell` echoes are user-visible input (same treatment as the cold path).
      return { kind: 'user', payload: origin };
    default:
      return { kind: 'other', payload: origin };
  }
}

function mapTurnEndState(reason: 'completed' | 'cancelled' | 'failed' | 'blocked'): TurnState {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'blocked':
      // The engine folds `blocked` into `failed` at the wire edge (see
      // `TurnEndReason`); the transcript mirrors that contract.
      return 'failed';
  }
}

/** Engine todo tool name and the singleton todo entity id (the engine store key). */
const TODO_LIST_TOOL_NAME = 'TodoList';
const TODO_ENTITY_ID = 'todo';

/** TodoList write args → todo items; undefined when the call is a read or malformed. */
function todoWriteItems(input: unknown): TranscriptTodo['items'] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: { title: string; status: 'pending' | 'in_progress' | 'done' }[] = [];
  for (const entry of todos) {
    const title = (entry as { title?: unknown } | undefined)?.title;
    const status = (entry as { status?: unknown } | undefined)?.status;
    if (typeof title !== 'string') return undefined;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') return undefined;
    items.push({ title, status });
  }
  return items;
}

/** Tool args arrive parsed in v2; tolerate a raw JSON string (parse-or-keep). */
function parseToolArgs(args: unknown): unknown {
  if (typeof args !== 'string' || args.length === 0) return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}
