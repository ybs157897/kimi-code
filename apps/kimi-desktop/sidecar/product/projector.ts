/**
 * Product event projector — subscribes (via the in-process klient) to one
 * agent's event stream plus its session's interaction stream, and projects each
 * raw klient event to a kimi-web `WireEvent` (the `event.*` shapes in
 * `wire.ts`). It mirrors the semantics of kimi-web's client-side
 * `agentEventProjector.ts` (message log, content indexing, usage fold) but emits
 * wire frames instead of `AppEvent`s, so S3 can feed them through the existing
 * `toAppEvent` → `eventReducer` pipeline unchanged.
 *
 * First-slice coverage: turn lifecycle (work_changed), assistant text/thinking
 * deltas, tool dispatch/progress/result, usage, approval/question request +
 * resolve, and notice/warning/error.
 */

import type { IDisposable, Klient } from '@moonshot-ai/klient';
import type { Interaction } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';

import { toWireApproval, toWireQuestion, ulid } from './builders.js';
import type {
  WireEvent,
  WireMessageContent,
  WireSessionUsage,
  WireSessionUsageDelta,
} from './wire.js';

/** Raw agent event payloads are read defensively (loose engine shapes). */
type RawEvent = Record<string, unknown>;

interface ProjectState {
  seq: number;
  currentAssistantMsgId: string | undefined;
  /** Wire content of the in-flight assistant message (drives content_index). */
  content: WireMessageContent[];
  currentPromptId: string | undefined;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  contextTokens: number;
  contextLimit: number;
  turnCount: number;
  /** An error notice was already emitted this turn (dedupe turn.ended). */
  turnErrorEmitted: boolean;
  /** Pending interaction id → kind, for routing resolutions. */
  interactions: Map<string, 'approval' | 'question'>;
}

function createState(): ProjectState {
  return {
    seq: 0,
    currentAssistantMsgId: undefined,
    content: [],
    currentPromptId: undefined,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    contextTokens: 0,
    contextLimit: 0,
    turnCount: 0,
    turnErrorEmitted: false,
    interactions: new Map(),
  };
}

function str(raw: RawEvent, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' ? v : undefined;
}

function num(raw: RawEvent, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Normalise the raw token-usage shape emitted by agent-core. */
function readUsage(raw: unknown): { input: number; output: number; cacheRead: number; cacheCreate: number } {
  if (!raw || typeof raw !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const u = raw as Record<string, number | undefined>;
  return {
    input: u['inputOther'] ?? u['input_tokens'] ?? 0,
    output: u['output'] ?? u['output_tokens'] ?? 0,
    cacheRead: u['inputCacheRead'] ?? u['cache_read_input_tokens'] ?? 0,
    cacheCreate: u['inputCacheCreation'] ?? u['cache_creation_input_tokens'] ?? 0,
  };
}

export class ProductProjector {
  constructor(private readonly klient: Klient) {}

  /**
   * Subscribe to a session/agent's projected product stream. Each projected
   * `WireEvent` is handed to `push`. Returns a disposable that detaches every
   * underlying subscription.
   */
  subscribe(sessionId: string, agentId: string, push: (event: WireEvent) => void): IDisposable {
    const state = createState();
    const subs: IDisposable[] = [];

    const emit = (event: WireEvent): void => {
      try {
        push(event);
      } catch {
        // A broken consumer must not take down the projector.
      }
    };

    /** Build a wire frame, stamping monotonic seq + timestamp. */
    const frame = <P>(type: string, payload: P): WireEvent =>
      ({
        type,
        seq: ++state.seq,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        payload,
      }) as unknown as WireEvent;

    const usageSnapshot = (): WireSessionUsage => ({
      input_tokens: state.totalInput,
      output_tokens: state.totalOutput,
      cache_read_tokens: state.totalCacheRead,
      cache_creation_tokens: state.totalCacheCreate,
      total_cost_usd: 0,
      context_tokens: state.contextTokens,
      context_limit: state.contextLimit,
      turn_count: state.turnCount,
    });

    const zeroDelta = (): WireSessionUsageDelta => ({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
    });

    const workChanged = (payload: {
      busy: boolean;
      main_turn_active?: boolean;
      pending_interaction?: 'none' | 'approval' | 'question';
      last_turn_reason?: 'completed' | 'cancelled' | 'failed';
    }): void => {
      emit(frame('event.session.work_changed', payload));
    };

    const usageUpdated = (delta?: WireSessionUsageDelta): void => {
      emit(frame('event.session.usage_updated', { usage: usageSnapshot(), delta: delta ?? zeroDelta() }));
    };

    /** Append a streamed delta, returning the content_index written (-1 if no
     *  in-flight assistant message). Mirrors the daemon projector's append. */
    const appendDelta = (kind: 'text' | 'thinking', delta: string): number => {
      const msgId = state.currentAssistantMsgId;
      if (msgId === undefined) return -1;
      const last = state.content.at(-1);
      if (last !== undefined && last.type === kind) {
        if (kind === 'text') (last as { type: 'text'; text: string }).text += delta;
        else (last as { type: 'thinking'; thinking: string }).thinking += delta;
        return state.content.length - 1;
      }
      state.content.push(
        kind === 'text' ? { type: 'text', text: delta } : { type: 'thinking', thinking: delta },
      );
      return state.content.length - 1;
    };

    const messageUpdated = (status: 'pending' | 'completed' | 'error'): void => {
      const msgId = state.currentAssistantMsgId;
      if (msgId === undefined) return;
      emit(
        frame('event.message.updated', {
          message_id: msgId,
          content: state.content.map((c) => ({ ...c })),
          status,
        }),
      );
    };

    const notice = (severity: 'info' | 'warning' | 'error', raw: RawEvent): void => {
      emit(
        frame('event.product.notice', {
          severity,
          code: str(raw, 'code'),
          msg: str(raw, 'message') ?? '',
          name: str(raw, 'name'),
        }),
      );
    };

    // ── agent event handlers ────────────────────────────────────────────────

    const onTurnStarted = (raw: RawEvent): void => {
      const turnId = num(raw, 'turnId');
      if (state.currentPromptId === undefined) state.currentPromptId = ulid('pr_');
      if (turnId !== undefined) state.currentPromptId = state.currentPromptId;
      state.turnErrorEmitted = false;
      workChanged({ busy: true, main_turn_active: true, pending_interaction: 'none' });
    };

    const onTurnStepStarted = (): void => {
      const msgId = ulid('msg_');
      state.currentAssistantMsgId = msgId;
      state.content = [];
      emit(
        frame('event.message.created', {
          message: {
            id: msgId,
            session_id: sessionId,
            role: 'assistant',
            content: [],
            created_at: new Date().toISOString(),
            prompt_id: state.currentPromptId,
          },
        }),
      );
    };

    const onAssistantDelta = (raw: RawEvent): void => {
      const delta = str(raw, 'delta');
      if (delta === undefined || delta.length === 0) return;
      const index = appendDelta('text', delta);
      if (index < 0) return;
      emit(
        frame('event.assistant.delta', {
          message_id: state.currentAssistantMsgId,
          content_index: index,
          delta: { text: delta },
        }),
      );
    };

    const onThinkingDelta = (raw: RawEvent): void => {
      const delta = str(raw, 'delta');
      if (delta === undefined || delta.length === 0) return;
      const index = appendDelta('thinking', delta);
      if (index < 0) return;
      emit(
        frame('event.assistant.delta', {
          message_id: state.currentAssistantMsgId,
          content_index: index,
          delta: { thinking: delta },
        }),
      );
    };

    const onToolCallStarted = (raw: RawEvent): void => {
      const msgId = state.currentAssistantMsgId;
      const toolCallId = str(raw, 'toolCallId');
      if (msgId === undefined || toolCallId === undefined) return;
      const toolName = str(raw, 'name') ?? str(raw, 'toolName') ?? '';
      state.content.push({
        type: 'tool_use',
        tool_call_id: toolCallId,
        tool_name: toolName,
        input: raw['args'] ?? raw['input'] ?? {},
      });
      messageUpdated('pending');
    };

    const onToolProgress = (raw: RawEvent): void => {
      const toolCallId = str(raw, 'toolCallId');
      if (toolCallId === undefined) return;
      const update = (raw['update'] ?? {}) as RawEvent;
      const chunk = str(update, 'text') ?? str(update, 'message') ?? str(raw, 'message') ?? '';
      if (chunk.length === 0) return;
      const stream = update['kind'] === 'stderr' || update['stream'] === 'stderr' ? 'stderr' : 'stdout';
      emit(frame('event.tool.output', { tool_call_id: toolCallId, chunk, stream }));
    };

    const onToolResult = (raw: RawEvent): void => {
      const toolCallId = str(raw, 'toolCallId');
      if (toolCallId === undefined) return;
      emit(
        frame('event.message.created', {
          message: {
            id: ulid('msg_'),
            session_id: sessionId,
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                tool_call_id: toolCallId,
                output: raw['output'],
                is_error: raw['isError'] === true,
              },
            ],
            created_at: new Date().toISOString(),
            prompt_id: state.currentPromptId,
          },
        }),
      );
      // Next step.started opens a fresh assistant message.
      state.currentAssistantMsgId = undefined;
      state.content = [];
    };

    const onTurnStepCompleted = (raw: RawEvent): void => {
      const u = readUsage(raw['usage']);
      state.totalInput += u.input;
      state.totalOutput += u.output;
      state.totalCacheRead += u.cacheRead;
      state.totalCacheCreate += u.cacheCreate;
      messageUpdated('completed');
    };

    const onAgentStatusUpdated = (raw: RawEvent): void => {
      const contextTokens = num(raw, 'contextTokens');
      const maxContextTokens = num(raw, 'maxContextTokens');
      if (contextTokens !== undefined) state.contextTokens = contextTokens;
      if (maxContextTokens !== undefined) state.contextLimit = maxContextTokens;
      const u = readUsage(raw['usage']);
      if (u.input || u.output || u.cacheRead || u.cacheCreate) {
        state.totalInput += u.input;
        state.totalOutput += u.output;
        state.totalCacheRead += u.cacheRead;
        state.totalCacheCreate += u.cacheCreate;
      }
      usageUpdated();
    };

    const onTurnEnded = (raw: RawEvent): void => {
      const reason = str(raw, 'reason') ?? 'completed';
      messageUpdated(reason === 'failed' || reason === 'blocked' ? 'error' : 'completed');
      state.turnCount += 1;
      usageUpdated();
      const lastTurnReason =
        reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
      workChanged({ busy: false, main_turn_active: false, last_turn_reason: lastTurnReason });
      // Surface a structured error notice for a failed turn. The engine may
      // also emit a standalone `error` event either side of turn.ended; the
      // turnErrorEmitted flag (reset on turn.started) keeps it to one notice.
      const error = raw['error'];
      if (lastTurnReason === 'failed' && !state.turnErrorEmitted && error && typeof error === 'object') {
        state.turnErrorEmitted = true;
        notice('error', error as RawEvent);
      }
      state.currentAssistantMsgId = undefined;
      state.content = [];
      state.currentPromptId = undefined;
    };

    const onError = (raw: RawEvent): void => {
      if (state.turnErrorEmitted) return;
      state.turnErrorEmitted = true;
      notice('error', raw);
    };
    const onWarning = (raw: RawEvent): void => notice('warning', raw);
    const onNotice = (raw: RawEvent): void => notice('info', raw);

    // ── interaction handlers (approvals / questions) ────────────────────────

    const onInteractionsChanged = (pending: readonly Interaction[]): void => {
      const seen = new Set<string>();
      for (const interaction of pending) {
        seen.add(interaction.id);
        const known = state.interactions.get(interaction.id);
        if (known !== undefined) continue;
        if (interaction.kind === 'approval') {
          state.interactions.set(interaction.id, 'approval');
          emit(frame('event.approval.requested', toWireApproval(interaction, sessionId)));
        } else if (interaction.kind === 'question') {
          state.interactions.set(interaction.id, 'question');
          emit(frame('event.question.requested', toWireQuestion(interaction, sessionId)));
        }
      }
      // Drop resolutions that happened between change notifications.
      for (const id of [...state.interactions.keys()]) {
        if (!seen.has(id)) state.interactions.delete(id);
      }
    };

    const onInteractionsResolved = (resolution: { id: string; response: unknown }): void => {
      const kind = state.interactions.get(resolution.id);
      if (kind === undefined) return;
      state.interactions.delete(resolution.id);
      const resolvedAt = new Date().toISOString();
      if (kind === 'approval') {
        const response = (resolution.response ?? {}) as { decision?: 'approved' | 'rejected' | 'cancelled' };
        emit(
          frame('event.approval.resolved', {
            approval_id: resolution.id,
            decision: response.decision ?? 'cancelled',
            resolved_by: 'user',
            resolved_at: resolvedAt,
          }),
        );
      } else {
        emit(
          frame('event.question.answered', {
            question_id: resolution.id,
            answers: {},
            resolved_by: 'user',
            resolved_at: resolvedAt,
          }),
        );
      }
    };

    // ── attach subscriptions ────────────────────────────────────────────────

    const agent = this.klient.session(sessionId).agent(agentId);
    const agentEvents = agent.events;
    subs.push(
      agentEvents.on('turn.started', onTurnStarted),
      agentEvents.on('turn.step.started', onTurnStepStarted),
      agentEvents.on('assistant.delta', onAssistantDelta),
      agentEvents.on('thinking.delta', onThinkingDelta),
      agentEvents.on('tool.call.started', onToolCallStarted),
      agentEvents.on('tool.progress', onToolProgress),
      agentEvents.on('tool.result', onToolResult),
      agentEvents.on('turn.step.completed', onTurnStepCompleted),
      agentEvents.on('agent.status.updated', onAgentStatusUpdated),
      agentEvents.on('turn.ended', onTurnEnded),
      agentEvents.on('error', onError),
      agentEvents.on('warning', onWarning),
      agentEvents.on('notice', onNotice),
    );

    const sessionEvents = this.klient.session(sessionId).events;
    subs.push(
      sessionEvents.on('interactions.changed', onInteractionsChanged),
      sessionEvents.on('interactions.resolved', onInteractionsResolved),
    );

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const sub of subs) sub.dispose();
        subs.length = 0;
      },
    };
  }
}
