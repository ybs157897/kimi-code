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
 *
 * Complete-event coverage adds: tasks/subagents (task lifecycle, subagent
 * lifecycle with per-agent task patching, shell output), session metadata
 * changes, goal updates, prompt lifecycle, and compaction.
 *
 * Seq is NOT stamped here: the projector emits unsequenced draft frames and the
 * `ProductStreamHub` owns the monotonic per-(session, agent) seq + journal, so
 * the same seq space survives detach/re-attach (see stream.ts).
 */

import type { IDisposable, Klient } from '@moonshot-ai/klient';
import type { Interaction } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';

import { toWireApproval, toWireGoal, toWireQuestion, ulid } from './builders.js';
import type {
  WireEvent,
  WireMessageContent,
  WireSessionUsage,
  WireSessionUsageDelta,
  WireTask,
} from './wire.js';

/** Raw agent event payloads are read defensively (loose engine shapes). */
type RawEvent = Record<string, unknown>;

interface ProjectState {
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
  /** Wire task rows keyed by task id (subagent id / task id), for patching. */
  tasks: Map<string, WireTask>;
}

function createState(): ProjectState {
  return {
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
    tasks: new Map(),
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
    let disposed = false;

    const emit = (event: WireEvent): void => {
      try {
        push(event);
      } catch {
        // A broken consumer must not take down the projector.
      }
    };

    /** Build a wire draft. Seq is left at 0 and stamped by the stream hub. */
    const frame = <P>(type: string, payload: P): WireEvent =>
      ({
        type,
        seq: 0,
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
      // Side-channel (BTW) agents: signal the turn end explicitly so the
      // desktop client can synthesize the daemon-equivalent `agentTurnEnded`
      // AppEvent. The main agent path keeps emitting only the events
      // kimi-web's `toAppEvent` knows, so this frame is main-only-excluded.
      if (agentId !== 'main') {
        emit(
          frame('event.turn.ended', {
            reason: lastTurnReason,
          }),
        );
      }
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

    // ── task / subagent handlers ───────────────────────────────────────────

    /** Merge a patch into the stored task row (or seed a base subagent task)
     *  and return the merged row. Mirrors the daemon projector's
     *  `patchSubagent`: each subagent lifecycle frame re-emits the patched
     *  task as `event.task.created` so the UI reducer converges on one row
     *  per subagent id. */
    const taskPatch = (id: string, patch: Partial<WireTask>): WireTask => {
      const prev = state.tasks.get(id);
      const base: WireTask = prev ?? {
        id,
        session_id: sessionId,
        kind: 'subagent',
        description: 'Sub Agent',
        status: 'running',
        created_at: new Date().toISOString(),
        subagent_phase: 'queued',
      };
      const next: WireTask = { ...base, ...patch, id, session_id: sessionId };
      state.tasks.set(id, next);
      return next;
    };

    // ── subagent transcript → task progress ─────────────────────────────────
    // The main-agent stream never carries a subagent's own transcript frames:
    // `IEventBus` is bound per Agent scope (one EventBusService per agent), so a
    // spawned subagent's `thinking.delta` / `assistant.delta` / `tool.*` frames
    // publish on ITS event bus, not the requester's. Without a dedicated
    // subscription here, `event.task.progress` is never emitted for subagents
    // and the detail panel sits on "waiting for thinking or tool progress…"
    // forever. Mirror the daemon projector's `projectSubagentProgress`: attach a
    // per-subagent subscription and fold its frames into task progress events.
    const subagentSubs = new Map<string, IDisposable>();

    const attachSubagentTranscript = (subagentId: string): void => {
      if (subagentSubs.has(subagentId)) return;
      const inner: IDisposable[] = [];
      const progress = (kind: 'line' | 'text' | 'thinking', chunk: string): void => {
        emit(
          frame('event.task.progress', {
            task_id: subagentId,
            output_chunk: chunk,
            stream: 'stdout',
            kind,
          }),
        );
      };

      let subEvents: ReturnType<ReturnType<Klient['session']>['agent']>['events'];
      try {
        // The subagent may already be gone by the time the spawned frame is
        // projected (aborted between launch and registration); a failed
        // transcript subscription must never take the main stream down.
        subEvents = this.klient.session(sessionId).agent(subagentId).events;
      } catch {
        return;
      }

      // Streamed text / thinking: forward each delta so the reducer
      // concatenates into `AppTask.text` / `AppTask.thinking`. Thinking-capable
      // models often emit only `thinking.delta` for a long stretch — without
      // projecting those, the panel stays blank until the first tool call or
      // assistant token.
      inner.push(
        subEvents.on('thinking.delta', (raw) => {
          const delta = str(raw as unknown as RawEvent, 'delta');
          if (delta === undefined || delta.length === 0) return;
          progress('thinking', delta);
        }),
        subEvents.on('assistant.delta', (raw) => {
          const delta = str(raw as unknown as RawEvent, 'delta');
          if (delta === undefined || delta.length === 0) return;
          progress('text', delta);
        }),
        subEvents.on('tool.call.started', (raw) => {
          const p = raw as unknown as RawEvent;
          const name = str(p, 'name') ?? str(p, 'toolName') ?? 'tool';
          const label = name.replace(/_\d+$/, '');
          progress('line', `Calling ${label}`);
        }),
        subEvents.on('tool.progress', (raw) => {
          const p = raw as unknown as RawEvent;
          const update = (p['update'] ?? {}) as RawEvent;
          const chunk = str(update, 'text') ?? str(update, 'message') ?? str(p, 'message');
          if (chunk === undefined || chunk.length === 0) return;
          progress('line', chunk);
        }),
      );
      subagentSubs.set(subagentId, {
        dispose: () => {
          for (const sub of inner) sub.dispose();
          inner.length = 0;
        },
      });
    };

    const detachSubagentTranscript = (subagentId: string): void => {
      subagentSubs.get(subagentId)?.dispose();
      subagentSubs.delete(subagentId);
    };

    const onSubagentSpawned = (raw: RawEvent): void => {
      const subagentId = str(raw, 'subagentId');
      if (subagentId === undefined || subagentId.length === 0) return;
      const subagentName = str(raw, 'subagentName');
      const task = taskPatch(subagentId, {
        description: str(raw, 'description') ?? subagentName ?? 'Sub Agent',
        status: 'running',
        subagent_phase: 'queued',
        subagent_type: subagentName,
        parent_tool_call_id: str(raw, 'parentToolCallId'),
        swarm_index: num(raw, 'swarmIndex'),
        run_in_background: raw['runInBackground'] === true,
      });
      emit(frame('event.task.created', { task }));
      attachSubagentTranscript(subagentId);
    };

    const onSubagentStarted = (raw: RawEvent): void => {
      const subagentId = str(raw, 'subagentId');
      if (subagentId === undefined || subagentId.length === 0) return;
      const task = taskPatch(subagentId, {
        status: 'running',
        subagent_phase: 'working',
        started_at: new Date().toISOString(),
      });
      emit(frame('event.task.created', { task }));
    };

    const onSubagentSuspended = (raw: RawEvent): void => {
      const subagentId = str(raw, 'subagentId');
      if (subagentId === undefined || subagentId.length === 0) return;
      const task = taskPatch(subagentId, {
        status: 'running',
        subagent_phase: 'suspended',
        suspended_reason: str(raw, 'reason'),
      });
      emit(frame('event.task.created', { task }));
    };

    const onSubagentCompleted = (raw: RawEvent): void => {
      const subagentId = str(raw, 'subagentId');
      if (subagentId === undefined || subagentId.length === 0) return;
      const outputPreview = str(raw, 'resultSummary');
      const task = taskPatch(subagentId, {
        status: 'completed',
        subagent_phase: 'completed',
        completed_at: new Date().toISOString(),
        output_preview: outputPreview,
      });
      emit(frame('event.task.created', { task }));
      emit(
        frame('event.task.completed', {
          task_id: subagentId,
          status: 'completed',
          output_preview: outputPreview,
        }),
      );
      detachSubagentTranscript(subagentId);
    };

    const onSubagentFailed = (raw: RawEvent): void => {
      const subagentId = str(raw, 'subagentId');
      if (subagentId === undefined || subagentId.length === 0) return;
      const outputPreview = str(raw, 'error');
      const task = taskPatch(subagentId, {
        status: 'failed',
        subagent_phase: 'failed',
        completed_at: new Date().toISOString(),
        output_preview: outputPreview,
      });
      emit(frame('event.task.created', { task }));
      emit(
        frame('event.task.completed', {
          task_id: subagentId,
          status: 'failed',
          output_preview: outputPreview,
        }),
      );
      detachSubagentTranscript(subagentId);
    };

    const onTaskStarted = (raw: RawEvent): void => {
      const info = (raw['info'] ?? {}) as RawEvent;
      const taskIdRaw = info['taskId'];
      const taskId =
        typeof taskIdRaw === 'string' && taskIdRaw.length > 0
          ? taskIdRaw
          : typeof taskIdRaw === 'number'
            ? String(taskIdRaw)
            : ulid('task_');
      const startedAtNum = num(info, 'startedAt');
      const startedAt = startedAtNum === undefined ? undefined : new Date(startedAtNum).toISOString();
      const kind = str(info, 'kind');
      const command = str(info, 'command');
      const description = str(info, 'description') ?? command ?? 'Background task';
      if (kind === 'agent') {
        // A background subagent registers under its own task id, but the
        // subagent-* lifecycle frames key by the subagent (agent) id. Key the
        // row by the agent id — like the daemon projector — so late-subscribing
        // clients still converge on ONE row when task.started arrives without a
        // preceding subagent.spawned. Fall back to a standalone taskId-keyed
        // row when no agent id is present.
        const agentId = str(info, 'agentId');
        if (agentId !== undefined && agentId.length > 0) {
          const task = taskPatch(agentId, {
            description,
            status: 'running',
            started_at: startedAt,
            subagent_phase: 'queued',
            run_in_background: true,
            background_task_id: taskId,
          });
          emit(frame('event.task.created', { task }));
          // A background subagent's transcript lives on its own agent stream;
          // attach it here too (idempotent) so progress survives when the
          // `subagent.spawned` frame was missed or arrives later.
          attachSubagentTranscript(agentId);
          return;
        }
        emit(
          frame('event.task.created', {
            task: {
              id: taskId,
              session_id: sessionId,
              kind: 'subagent',
              description,
              status: 'running',
              created_at: startedAt ?? new Date().toISOString(),
              started_at: startedAt,
              subagent_phase: 'queued',
              run_in_background: true,
            },
          }),
        );
        return;
      }
      emit(
        frame('event.task.created', {
          task: {
            id: taskId,
            session_id: sessionId,
            kind: kind === 'process' ? 'bash' : 'tool',
            description,
            command: kind === 'process' ? command : undefined,
            status: 'running',
            created_at: startedAt ?? new Date().toISOString(),
            started_at: startedAt,
            output_preview:
              kind === 'process' && command !== undefined ? `$ ${command}` : undefined,
          },
        }),
      );
    };

    const onTaskTerminated = (raw: RawEvent): void => {
      const info = (raw['info'] ?? {}) as RawEvent;
      const taskIdRaw = info['taskId'];
      const taskId =
        typeof taskIdRaw === 'string' && taskIdRaw.length > 0
          ? taskIdRaw
          : typeof taskIdRaw === 'number'
            ? String(taskIdRaw)
            : undefined;
      if (taskId === undefined) return;
      const status = str(info, 'status');
      const exitCode = num(info, 'exitCode');
      // 'killed' → cancelled; 'failed'/'timed_out'/'lost' (or any non-zero
      // exit code) → failed; everything else completes.
      let wireStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      if (status === 'killed') {
        wireStatus = 'cancelled';
      } else if (
        status === 'failed' ||
        status === 'timed_out' ||
        status === 'lost' ||
        (exitCode !== undefined && exitCode !== 0)
      ) {
        wireStatus = 'failed';
      }
      // No output_preview here: the command is already kept on the task as
      // `command`; re-previewing `$ <command>` would clobber real output.
      // Background subagents key their row by the AGENT id (see onTaskStarted),
      // not the task-registry id — emit the completed frame against that same
      // id, otherwise the UI reducer can't find the row and the task stays
      // "running" forever after the subagent finishes.
      const kind = str(info, 'kind');
      const agentId = str(info, 'agentId');
      const completedTaskId =
        kind === 'agent' && agentId !== undefined && agentId.length > 0 ? agentId : taskId;
      emit(frame('event.task.completed', { task_id: completedTaskId, status: wireStatus }));
      // Release the transcript subscription of a finished background subagent.
      if (kind === 'agent' && agentId !== undefined && agentId.length > 0) {
        detachSubagentTranscript(agentId);
      }
    };

    const onShellOutput = (raw: RawEvent): void => {
      const update = (raw['update'] ?? {}) as RawEvent;
      const chunk = str(update, 'text') ?? '';
      if (chunk.length === 0) return;
      const commandId = str(raw, 'commandId');
      const taskId =
        str(raw, 'taskId') ?? (commandId !== undefined ? `shell-${commandId}` : undefined);
      if (taskId === undefined) return;
      emit(
        frame('event.task.progress', {
          task_id: taskId,
          output_chunk: chunk,
          stream: update['kind'] === 'stderr' ? 'stderr' : 'stdout',
        }),
      );
    };

    // ── goal / prompt / compaction / metadata handlers ─────────────────────

    const onGoalUpdated = (raw: RawEvent): void => {
      emit(frame('event.goal.updated', { snapshot: toWireGoal(raw['snapshot']) }));
    };

    const onPromptCompleted = (raw: RawEvent): void => {
      const promptId = str(raw, 'promptId');
      if (promptId === undefined || promptId.length === 0) return;
      const reason = str(raw, 'reason');
      emit(
        frame('event.prompt.completed', {
          prompt_id: promptId,
          finished_at: str(raw, 'finishedAt') ?? new Date().toISOString(),
          reason:
            reason === 'completed' || reason === 'failed' || reason === 'blocked'
              ? reason
              : undefined,
        }),
      );
    };

    const onPromptAborted = (raw: RawEvent): void => {
      const promptId = str(raw, 'promptId');
      if (promptId === undefined || promptId.length === 0) return;
      emit(
        frame('event.prompt.aborted', {
          prompt_id: promptId,
          aborted_at: str(raw, 'abortedAt') ?? new Date().toISOString(),
        }),
      );
    };

    const onCompactionStarted = (raw: RawEvent): void => {
      emit(
        frame('event.compaction.started', {
          trigger: str(raw, 'trigger') === 'manual' ? 'manual' : 'auto',
          instruction: str(raw, 'instruction'),
        }),
      );
    };

    const onCompactionCompleted = (raw: RawEvent): void => {
      const result = (raw['result'] ?? {}) as RawEvent;
      emit(
        frame('event.compaction.completed', {
          tokens_before: num(result, 'tokensBefore'),
          tokens_after: num(result, 'tokensAfter'),
          summary: str(result, 'summary'),
        }),
      );
    };

    const onCompactionCancelled = (): void => {
      emit(frame('event.compaction.cancelled', {}));
    };

    /**
     * A scheduled reminder fired into the session. The engine persists the
     * injected user message but does not broadcast a message.created for it —
     * synthesize one here so the notice shows up live, mirroring the daemon
     * projector's cron.fired branch (agentEventProjector.ts). The promptId is
     * intentionally omitted (the daemon client caches promptIds for Stop and a
     * synthetic id would clobber the real one); a later snapshot reload
     * replaces the message log wholesale, so this copy never duplicates the
     * persisted one.
     */
    const onCronFired = (raw: RawEvent): void => {
      const origin = raw['origin'];
      const prompt = str(raw, 'prompt');
      if (
        origin === null ||
        typeof origin !== 'object' ||
        (origin as Record<string, unknown>)['kind'] !== 'cron_job' ||
        prompt === undefined ||
        prompt.length === 0
      ) {
        return;
      }
      emit(
        frame('event.message.created', {
          message: {
            id: ulid('cron_'),
            session_id: sessionId,
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            created_at: new Date().toISOString(),
            metadata: { origin: origin as Record<string, unknown> },
          },
        }),
      );
    };

    /** Session metadata changed — read the fresh meta and emit a lightweight
     *  patch for the changed keys (title / lastPrompt). Best-effort: if the
     *  meta read fails, skip silently. */
    const onMetadataChanged = async (payload: { changed: readonly string[] }): Promise<void> => {
      if (payload.changed.length === 0) return;
      try {
        const meta = await this.klient.session(sessionId).get();
        const patch: { title?: string; lastPrompt?: string } = {};
        if (
          payload.changed.includes('title') &&
          typeof meta.title === 'string' &&
          meta.title.length > 0
        ) {
          patch.title = meta.title;
        }
        if (payload.changed.includes('lastPrompt') && typeof meta.lastPrompt === 'string') {
          patch.lastPrompt = meta.lastPrompt;
        }
        if (patch.title !== undefined || patch.lastPrompt !== undefined) {
          emit(frame('event.session.meta.updated', { patch }));
        }
      } catch {
        // Best-effort meta read — skip silently when it fails.
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
      // Tasks / subagents / goal / prompt / compaction
      agentEvents.on('task.started', onTaskStarted),
      agentEvents.on('task.terminated', onTaskTerminated),
      agentEvents.on('subagent.spawned', onSubagentSpawned),
      agentEvents.on('subagent.started', onSubagentStarted),
      agentEvents.on('subagent.suspended', onSubagentSuspended),
      agentEvents.on('subagent.completed', onSubagentCompleted),
      agentEvents.on('subagent.failed', onSubagentFailed),
      agentEvents.on('shell.output', onShellOutput),
      agentEvents.on('goal.updated', onGoalUpdated),
      agentEvents.on('prompt.completed', onPromptCompleted),
      agentEvents.on('prompt.aborted', onPromptAborted),
      agentEvents.on('compaction.started', onCompactionStarted),
      agentEvents.on('compaction.completed', onCompactionCompleted),
      agentEvents.on('compaction.cancelled', onCompactionCancelled),
      agentEvents.on('cron.fired', onCronFired),
    );

    const sessionEvents = this.klient.session(sessionId).events;
    subs.push(
      sessionEvents.on('interactions.changed', onInteractionsChanged),
      sessionEvents.on('interactions.resolved', onInteractionsResolved),
      sessionEvents.on('metadata.changed', onMetadataChanged),
    );

    // Recovered subagents (client re-subscribed after the spawn already fired,
    // or a persisted agent restored from a snapshot) never re-broadcast
    // `subagent.spawned`, so their transcript subscription would never attach
    // and the detail panel would stay blank for the whole run. Sweep the
    // session's registered agents once and attach any missing ones.
    if (agentId === 'main') {
      void this.klient
        .session(sessionId)
        .agents()
        .then((agents) => {
          if (disposed) return;
          for (const id of Object.keys(agents)) {
            // The registry includes the main agent itself; only subagents need
            // a transcript subscription.
            if (id === 'main') continue;
            attachSubagentTranscript(id);
          }
        })
        .catch(() => {
          // Metadata read failure is non-fatal; live spawns still attach.
        });
    }

    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const sub of subs) sub.dispose();
        subs.length = 0;
        for (const sub of subagentSubs.values()) sub.dispose();
        subagentSubs.clear();
      },
    };
  }
}
