/**
 * `SessionEventBroadcaster` — per-session single fan-out point that turns agent
 * events (via the per-agent `IEventBus`) into a sequenced,
 * journaled, replayable `/api/v1/ws` event stream (the `{seq, epoch}` watermark).
 *
 * Port of v1's `WSBroadcastService` (`packages/server/.../wsBroadcastService.ts`),
 * adapted to v2 where agent events live on the per-agent `IEventBus`
 * (not a Core firehose). For each session it:
 *
 *   1. Subscribes to every agent's `IEventBus` via
 *      `IAgentLifecycleService` reach-down-via-handle (and `onDidCreate` /
 *      `onDidDispose` for late agents); `record` emissions are persisted and not
 *      broadcast (see step 3). The same lifecycle callbacks fan durable
 *      `agent.created` / `agent.disposed` facts out at session granularity
 *      (they bypass per-subscription agent allowlists but never leave the
 *      session). Also subscribes to the session's
 *      `ISessionInteractionService` and synthesizes the v1 approval/question
 *      protocol events from pending-set changes and resolutions.
 *   2. Attaches `agentId`/`sessionId` to build the wire `Event`.
 *   3. Classifies durable vs volatile — `isVolatileSignal` for the agent
 *      wire-emission path (`isVolatileEventType` remains for the global/model path).
 *   4. Durable events: assign the next per-session `seq` (monotonic across
 *      restarts), persist to the `SessionEventJournal`, cache in an in-memory
 *      tail, fan out.
 *   5. Volatile events: fan out live with the current durable watermark as
 *      `seq` and `volatile: true`. Never journaled, never replayed.
 *   6. Exposes replay (`getBufferedSince`) keyed by `{seq, epoch}` cursors and
 *      an atomic `getSnapshotState` for the snapshot route.
 *
 * A session is activated (journaling starts) on first `subscribe` /
 * `getSnapshotState` / `getCursor` and stays active for the process lifetime so
 * the journal is continuous from first activation onward.
 *
 * Fan-out split: global events ({@link isGlobalEvent} — `session.meta.updated`
 * plus the `event.session.*` / `event.workspace.*` / `event.config.*`
 * families, including every session's `event.session.work_changed`) are pushed
 * to EVERY established connection (registered via
 * {@link SessionEventBroadcaster.addGlobalTarget}, no subscription needed)
 * union every subscribed target. Session/agent events only reach connections
 * subscribed to that session, subject to the per-subscription agent allowlist
 * and the transcript suppression below. Transcript frames (`transcript.reset`
 * / `transcript.ops`) are a separate channel: they are governed by the
 * per-agent transcript grades alone and bypass the agent allowlist entirely.
 *
 * Transcript dedup: a connection subscribed to the transcript protocol
 * (grade ≠ 'off' for the emitting agent) no longer receives the
 * `session_event`s the transcript already projects — see
 * {@link TRANSCRIPT_PROJECTED_EVENT_TYPES}. Suppression is a per-connection
 * send-view crop only: the journal and tail keep recording every event, and
 * connections without a transcript spec are unaffected.
 */

import type {
  AgentActivityState,
  DomainEvent,
  GlobalEvent,
  IAgentScopeHandle,
  IDisposable,
  ISessionScopeHandle,
  Scope,
  SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  ISessionActivityView,
  ISessionInteractionService,
  ISessionIndex,
  ISessionLifecycleService,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import type { Event } from './events';
import { isVolatileEventType } from './events';
import type { SessionCursor } from '../../../protocol/ws-control';
import {
  detachGrades,
  filterOpsForGrade,
  gradeFor,
  needsResetOnTransition,
  redactSnapshotForGrade,
  type AgentTranscript,
  type TranscriptGrade,
  type TranscriptGradeSpec,
  type TranscriptOperation,
  type TranscriptOpsEvent,
  type TranscriptResetEvent,
  type TranscriptStore,
} from '@moonshot-ai/transcript';

import { readLegacyStatus, toLegacyPhase } from '../../../services/legacyStatus/legacyStatus';
import type { TranscriptService } from '../../../services/transcript/transcriptService';
import { isVolatileSignal, legacyTaskEvent } from './agentWireEvents';
import { isGlobalEvent, matchesAgentFilter, suppressedByTranscript } from './broadcasterFiltering';
import {
  DEFAULT_MAX_BUFFER_SIZE,
  GLOBAL_SESSION_ID,
  TRANSCRIPT_RESET_TAIL_TURNS,
  disposeSessionState,
  type AgentFilter,
  type BroadcastTarget,
  type BufferedSinceResult,
  type SessionSnapshotState,
  type SessionState,
  type TargetSubscription,
  type TranscriptStream,
} from './broadcasterTypes';
import {
  sessionCreatedPayload,
  sessionMetaUpdatedPayload,
  sessionMetaUpdatedSessionId,
} from './coreEventPayloads';
import { InFlightTurnTracker } from './inFlightTurnTracker';
import { interactionRequestedEvent, interactionResolvedEvent } from './interactionEvents';
import { SubagentRosterTracker } from './subagentRosterTracker';
import {
  type EventEnvelope,
  type JournalLogger,
  SessionEventJournal,
  sessionJournalPath,
} from './sessionEventJournal';

export {
  DEFAULT_MAX_BUFFER_SIZE,
  type AgentFilter,
  type BroadcastDelivery,
  type BroadcastTarget,
  type BufferedSinceResult,
  type ResyncReason,
  type SessionSnapshotState,
  type TargetSubscription,
} from './broadcasterTypes';

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Every established connection, subscribed or not. Global events
   * ({@link isGlobalEvent}) fan out to this set (union the per-session
   * targets) so a freshly connected client sees session-level facts —
   * `event.session.created`, `session.meta.updated`, and every activated
   * session's `event.session.work_changed` — without subscribing to anything.
   */
  private readonly globalTargets = new Set<BroadcastTarget>();
  /**
   * Single-flight guard for session activation: without it, two concurrent
   * activations (WS subscribe racing a REST snapshot / replay / resync) each
   * built their own SessionState, bus subscriptions, and journal writer. The
   * leaked listeners all route through `onAgentEvent`, which looks up the
   * current state by session id, so they advance the SAME tracker and journal:
   * one source delta is emitted at consecutive offsets and adjacent durable
   * events receive distinct consecutive seqs. WS coalescing then folds the
   * adjacent delta copies into one doubled payload, producing the observed
   * per-chunk `AABBCC` stream while every seq and offset still looks valid.
   */
  private readonly pendingStates = new Map<string, Promise<SessionState | undefined>>();
  private readonly maxBufferSize: number;
  private readonly coreEventSubscription: IDisposable;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly eventsDir: string;
      readonly core: Scope;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
      /**
       * Optional transcript owner; when present, `subscribe` with transcript
       * grades activates per-agent op streaming for live sessions. Absent =
       * transcript disabled (tests / minimal embeds).
       */
      readonly transcriptService?: TranscriptService;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
  }

  /**
   * Register a freshly established connection for global-event fan-out. The
   * connection receives every global event ({@link isGlobalEvent}) from this
   * point on, with no per-session subscription required. Idempotent.
   */
  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  /** Drop a closed connection from the global fan-out set. Idempotent. */
  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
  }

  /**
   * Subscribe a connection to a session's stream (activates the session).
   *
   * When `transcriptGrades` is present the connection also joins the
   * session's transcript stream: every already-known agent whose grade is not
   * 'off' and that is an upgrade over the connection's previous grade
   * (`needsResetOnTransition`) is seeded with a `transcript.reset` snapshot;
   * later ops arrive as `transcript.ops`. Transcript frames are ALWAYS
   * volatile (current watermark as seq, never journaled, never replayed) —
   * frame loss surfaces through the ordinary backpressure → `resync_required`
   * → REST + re-subscribe path, which resets the transcript naturally.
   */
  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
    opts?: { deferTranscriptReset?: boolean; transcriptSince?: Record<string, number> },
  ): Promise<boolean> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return false;
    const prev = state.targets.get(target);
    state.targets.set(target, { agentFilter: filter, transcriptGrades });
    if (transcriptGrades !== undefined) {
      if (opts?.deferTranscriptReset === true) {
        // The baseline rides `flushTranscriptSeed` (after the caller's cursor
        // replay), so the reset's seq always follows the replayed backlog.
        state.transcriptSeeded.delete(target);
        state.deferredTranscriptSeeds.set(target, {
          spec: transcriptGrades,
          transcriptSince: opts.transcriptSince,
        });
      } else {
        state.deferredTranscriptSeeds.delete(target);
        // Gate the ops fan-out only while a replacement baseline is actually
        // on its way — a no-reset resubscribe must not black out the stream.
        const gated = this.willSendTranscriptReset(state, transcriptGrades, prev);
        if (gated) state.transcriptSeeded.delete(target);
        await this.subscribeTranscript(
          state,
          target,
          transcriptGrades,
          prev?.transcriptGrades,
          opts?.transcriptSince,
        );
        // A no-reset subscription owes no baseline — the target is seeded
        // either way (a fresh session with an empty roster must still
        // receive roster resets and ops once agents appear).
        if (state.targets.has(target)) state.transcriptSeeded.add(target);
      }
    }
    return true;
  }

  /**
   * Whether `subscribeTranscript` will send at least one reset for this
   * (target, spec) pair right now — an upgrade over the previous grades.
   */
  private willSendTranscriptReset(
    state: SessionState,
    spec: TranscriptGradeSpec,
    prev: TargetSubscription | undefined,
  ): boolean {
    const service = this.opts.transcriptService;
    if (service === undefined) return false;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return false;
    for (const descriptor of store.agents()) {
      const grade = gradeFor(spec, descriptor.agentId);
      if (grade === 'off') continue;
      if (needsResetOnTransition(gradeFor(prev?.transcriptGrades, descriptor.agentId), grade)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send the transcript baseline deferred by `subscribe(deferTranscriptReset)`
   * — callers run it after their cursor replay so the reset never lands ahead
   * of the replayed (lower-seq) backlog. The baseline is forced for every
   * admitted agent (no previous grades): volatile ops fanned out while the
   * target sat unseeded were dropped, so only a full reset closes that gap —
   * unless the subscription carried a `transcriptSince` cursor the journal
   * still covers, in which case replaying exactly the missed batches closes
   * it and no reset is sent for that agent.
   */
  async flushTranscriptSeed(sessionId: string, target: BroadcastTarget): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const deferred = state.deferredTranscriptSeeds.get(target);
    if (deferred === undefined) return;
    state.deferredTranscriptSeeds.delete(target);
    await this.subscribeTranscript(state, target, deferred.spec, undefined, deferred.transcriptSince);
    if (state.targets.has(target)) state.transcriptSeeded.add(target);
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.targets.delete(target);
    state.transcriptSeeded.delete(target);
    state.deferredTranscriptSeeds.delete(target);
  }

  /**
   * Detach one connection's transcript grade stream — agent-grained. With
   * `agentIds`, only the listed agents drop to an explicit 'off' (a listed
   * '*' removes the wildcard default); without it, the whole stream goes.
   * Non-activating and idempotent: unknown sessions/targets are no-ops. A
   * detached agent stops streaming on the next ops batch and its legacy
   * session_events resume automatically (both paths re-read the per-agent
   * grade); when no non-'off' grade remains the spec collapses to
   * `undefined`, the seeded/deferred baselines are dropped, and any in-flight
   * `subscribeTranscript` aborts on its grade re-read.
   */
  unsubscribeTranscript(
    sessionId: string,
    target: BroadcastTarget,
    agentIds?: readonly string[],
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const sub = state.targets.get(target);
    if (sub === undefined) return;
    const next =
      agentIds === undefined ? undefined : detachGrades(sub.transcriptGrades, agentIds);
    if (next === undefined) {
      state.targets.set(target, { agentFilter: sub.agentFilter, transcriptGrades: undefined });
      state.transcriptSeeded.delete(target);
      state.deferredTranscriptSeeds.delete(target);
    } else {
      state.targets.set(target, { agentFilter: sub.agentFilter, transcriptGrades: next });
    }
  }

  // ---------------------------------------------------------------------------
  // Transcript streaming (v1 incremental add-on; the durable event path is
  // untouched — transcript frames never advance seq and never touch the journal)
  // ---------------------------------------------------------------------------

  /**
   * Handle one connection's transcript subscription: attach the shared
   * per-session stream on first use and send `transcript.reset` snapshots for
   * every known agent admitted by `spec` that is an upgrade over the
   * connection's previous grade. A cold session (not live in this process)
   * silently skips streaming — cold transcripts stay REST-only. Live sessions
   * first await the initial wire-records backfill, so the seeded resets carry
   * the established main-agent transcript. Explicitly graded agents AND roster
   * agents admitted via the wildcard get their persisted history replayed
   * before their first reset — a roster agent whose `AgentTranscript` was
   * never materialized has nothing to snapshot, so without the backfill its
   * baseline is silently skipped. Grades are re-read from `state.targets`
   * after the awaits: subscribe work runs asynchronously, and a newer
   * subscribe/unsubscribe must not be answered with stale resets.
   */
  private async subscribeTranscript(
    state: SessionState,
    target: BroadcastTarget,
    spec: TranscriptGradeSpec,
    prev: TranscriptGradeSpec | undefined,
    transcriptSince?: Record<string, number>,
  ): Promise<void> {
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return;
    await service.whenReady(state.sessionId);
    const backfill = new Set(
      Object.keys(spec).filter((agentId) => agentId !== '*' && gradeFor(spec, agentId) !== 'off'),
    );
    for (const descriptor of store.agents()) {
      if (gradeFor(spec, descriptor.agentId) !== 'off') backfill.add(descriptor.agentId);
    }
    await Promise.all(
      [...backfill].map((agentId) => service.ensureAgentHistory(state.sessionId, agentId)),
    );
    // A newer subscribe/unsubscribe may have replaced this target's grades
    // while history was loading — only the latest subscription is owed resets.
    const current = state.targets.get(target);
    if (current?.transcriptGrades === undefined) return;
    const currentSpec = current.transcriptGrades;
    this.ensureTranscriptStream(state, store);
    for (const descriptor of store.agents()) {
      const grade = gradeFor(currentSpec, descriptor.agentId);
      if (grade === 'off') continue;
      const transcript = store.getAgent(descriptor.agentId);
      if (transcript === undefined) continue;
      // A catch-up cursor the journal still covers replaces the baseline
      // reset: replay exactly the batches past the cursor (grade-filtered, in
      // seq order) and the connection converges without a snapshot. Anything
      // the journal cannot vouch for falls through to the ordinary reset.
      const since = transcriptSince?.[descriptor.agentId] ?? transcriptSince?.['*'];
      if (since !== undefined) {
        const catchup = service.getOpsSince(state.sessionId, descriptor.agentId, since);
        if (catchup !== undefined && catchup.complete) {
          this.replayTranscriptOps(state, target, descriptor.agentId, grade, catchup.batches);
          continue;
        }
      }
      if (!needsResetOnTransition(gradeFor(prev, descriptor.agentId), grade)) {
        continue;
      }
      this.sendTranscriptReset(state, target, transcript, grade);
    }
  }

  /**
   * Replay journaled op batches to one connection (the `transcript_since`
   * catch-up path), grade-filtered like the live fan-out and stamped with
   * their original batch seqs.
   */
  private replayTranscriptOps(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    grade: TranscriptGrade,
    batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[],
  ): void {
    for (const batch of batches) {
      const filtered = filterOpsForGrade(grade, batch.ops);
      if (filtered.length === 0) continue;
      try {
        target.send(
          this.buildTranscriptEnvelope(state, 'transcript.ops', {
            agent_id: agentId,
            ops: filtered,
            seq: batch.seq,
          }),
        );
      } catch {
        // best-effort fan-out; a broken target is dropped, not fatal
      }
    }
  }

  /**
   * Attach the session's shared transcript fan-out: one mapped-ops
   * subscription for the whole session (grade filtering happens per target at
   * fan-out). New agents appearing later seed a `transcript.reset` for every
   * connected target whose grade admits them. The attachment is pinned to the
   * store instance: when the engine session closes, the service drops the
   * store together with its ops listener set while this session state
   * survives, so a subscribe after an in-daemon session resume must
   * re-register the fan-out against the rebuilt store — returning early on
   * any stale stream would deliver resets but never the live ops.
   */
  private ensureTranscriptStream(state: SessionState, store: TranscriptStore): void {
    if (state.transcriptStream?.store === store) return;
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const stream: TranscriptStream = {
      store,
      knownAgents: new Set(store.agents().map((d) => d.agentId)),
    };
    state.transcriptStream = stream;

    const opsDisposable = service.onSessionOps(state.sessionId, ({ agentId, ops }, seq) => {
      for (const [target, sub] of state.targets) {
        // No ops before the baseline reset (see subscribe).
        if (!state.transcriptSeeded.has(target)) continue;
        const grade = gradeFor(sub.transcriptGrades, agentId);
        const filtered = filterOpsForGrade(grade, ops);
        if (filtered.length === 0) continue;
        try {
          target.send(
            this.buildTranscriptEnvelope(state, 'transcript.ops', {
              agent_id: agentId,
              ops: filtered,
              seq,
            }),
          );
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    });
    if (opsDisposable !== undefined) state.lifecycleDisposables.push(opsDisposable);

    state.lifecycleDisposables.push(
      store.onRosterChange((agents) => {
        for (const descriptor of agents) {
          if (stream.knownAgents.has(descriptor.agentId)) continue;
          stream.knownAgents.add(descriptor.agentId);
          const transcript = store.getAgent(descriptor.agentId);
          if (transcript === undefined) continue;
          for (const [target, sub] of state.targets) {
            if (!state.transcriptSeeded.has(target)) continue;
            const grade = gradeFor(sub.transcriptGrades, descriptor.agentId);
            if (grade === 'off') continue;
            try {
              this.sendTranscriptReset(state, target, transcript, grade);
            } catch {
              // best-effort fan-out; a broken target is dropped, not fatal
            }
          }
        }
      }),
    );
  }

  /**
   * Volatile `transcript.reset` baseline: an items-empty snapshot (global
   * state only, redacted to the target's grade) plus the seq watermark.
   * History is paged over REST; live ops stream from the watermark.
   */
  private sendTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    transcript: AgentTranscript,
    grade: TranscriptGrade,
  ): void {
    const snapshot = redactSnapshotForGrade(
      grade,
      transcript.snapshot({ tailTurns: TRANSCRIPT_RESET_TAIL_TURNS }),
    );
    target.send(
      this.buildTranscriptEnvelope(state, 'transcript.reset', {
        agent_id: transcript.agentId,
        snapshot,
        has_more_older: snapshot.hasMoreOlder ?? false,
        // Watermark: the snapshot includes every op batch dispatched so far.
        seq: this.opts.transcriptService?.getSeqWatermark(state.sessionId, transcript.agentId),
      }),
    );
  }

  /**
   * All transcript frames are volatile and carry the current durable watermark
   * as `seq` (they never advance it and are never journaled or replayed). The
   * payload is the flat protocol event (`{ type, agent_id, … }`), matching the
   * `transcriptResetEventSchema` / `transcriptOpsEventSchema` shapes.
   */
  private buildTranscriptEnvelope(
    state: SessionState,
    type: 'transcript.reset' | 'transcript.ops',
    payload: Omit<TranscriptResetEvent, 'type'> | Omit<TranscriptOpsEvent, 'type'>,
  ): EventEnvelope {
    return {
      type,
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      volatile: true,
      session_id: state.sessionId,
      timestamp: new Date().toISOString(),
      payload: { type, ...payload },
    };
  }

  async getBufferedSince(
    sessionId: string,
    cursor: SessionCursor,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
  ): Promise<BufferedSinceResult> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return { events: [], resyncRequired: 'session_recreated', currentSeq: 0, epoch: '' };
    }
    // Drain so the cursor reflects everything dispatched so far.
    await state.queue;
    const { journal, tail } = state;
    const currentSeq = journal.seq;
    const { epoch } = journal;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      // Stale / foreign cursor (e.g. from a different epoch or a pre-journal client).
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    // Filter is a view crop over the session's single durable sequence: the
    // watermark and overflow checks above stay global, only the returned
    // envelopes are narrowed to the subscriber's agent allowlist — and, for a
    // transcript subscriber, stripped of the events the transcript already
    // projects. The journal itself keeps every event, so re-subscribing
    // without a transcript spec replays the complete history.
    const applyFilter = (
      entries: Array<{ seq: number; envelope: EventEnvelope }>,
    ): Array<{ seq: number; envelope: EventEnvelope }> =>
      filter === undefined && transcriptGrades === undefined
        ? entries
        : entries.filter(
            ({ envelope }) =>
              matchesAgentFilter(envelope, filter) &&
              !suppressedByTranscript(envelope, transcriptGrades),
          );

    // Serve from the memory tail when it fully covers the gap; else the journal.
    const tailStart = tail[0]?.seq;
    if (tailStart !== undefined && tailStart <= cursor.seq + 1) {
      const events = applyFilter(tail.filter((e) => e.seq > cursor.seq));
      return { events, resyncRequired: false, currentSeq, epoch };
    }
    const fromDisk = await journal.readSince(cursor.seq, this.maxBufferSize);
    return { events: applyFilter(fromDisk), resyncRequired: false, currentSeq, epoch };
  }

  async getCursor(sessionId: string): Promise<{ seq: number; epoch: string }> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      const cold = await this.readColdWatermark(sessionId);
      return cold ?? { seq: 0, epoch: '' };
    }
    await state.queue;
    return { seq: state.journal.seq, epoch: state.journal.epoch };
  }

  /** Atomic-at-queue watermark + in-flight turn, for the snapshot route. */
  async getSnapshotState(sessionId: string): Promise<SessionSnapshotState> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      const cold = await this.readColdWatermark(sessionId);
      return cold !== undefined
        ? { ...cold, inFlightTurn: null, subagents: [] }
        : { seq: 0, epoch: '', inFlightTurn: null, subagents: [] };
    }
    await state.queue;
    return {
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      inFlightTurn: state.tracker.get(sessionId),
      subagents: state.roster.get(sessionId),
    };
  }

  /**
   * Watermark for a session that is not live in this process but exists on disk
   * (carried over from a prior process, or created by v1). Opens the journal
   * transiently — no agent/interaction listeners and not cached in
   * `this.sessions` — so a later live activation still attaches subscriptions.
   * Returns `undefined` when the session is unknown to the index (truly absent).
   */
  private async readColdWatermark(
    sessionId: string,
  ): Promise<{ seq: number; epoch: string } | undefined> {
    const summary = await this.opts.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    const watermark = { seq: journal.seq, epoch: journal.epoch };
    await journal.close();
    return watermark;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.coreEventSubscription.dispose();
    for (const [sessionId, state] of this.sessions) {
      await disposeSessionState(state);
      // Transcript bindings die with the session stream (its store
      // subscriptions were disposed above; the producer binding goes here).
      this.opts.transcriptService?.dropSession(sessionId);
    }
    this.sessions.clear();
  }

  private ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(sessionId);
    if (pending === undefined) {
      pending = this.createSessionState(sessionId).finally(() => {
        if (this.pendingStates.get(sessionId) === pending) {
          this.pendingStates.delete(sessionId);
        }
      });
      this.pendingStates.set(sessionId, pending);
    }
    return pending;
  }

  private async createSessionState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return undefined;

    const session = this.opts.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) return undefined;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    if (this.closed) {
      await journal.close();
      return undefined;
    }
    const state: SessionState = {
      sessionId,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
    };
    this.sessions.set(sessionId, state);
    try {
      this.attachWorkView(session, state);
      this.attachAgents(sessionId, session, state);
      this.attachInteractions(sessionId, session, state);
    } catch (error) {
      this.sessions.delete(sessionId);
      await disposeSessionState(state);
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') return undefined;
      throw error;
    }
    return state;
  }

  private ensureGlobalState(): Promise<SessionState> {
    const existing = this.sessions.get(GLOBAL_SESSION_ID);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(GLOBAL_SESSION_ID);
    if (pending === undefined) {
      pending = this.createGlobalState().finally(() => {
        if (this.pendingStates.get(GLOBAL_SESSION_ID) === pending) {
          this.pendingStates.delete(GLOBAL_SESSION_ID);
        }
      });
      this.pendingStates.set(GLOBAL_SESSION_ID, pending);
    }
    return pending as Promise<SessionState>;
  }

  private async createGlobalState(): Promise<SessionState> {
    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, GLOBAL_SESSION_ID),
      this.opts.logger,
    );
    const state: SessionState = {
      sessionId: GLOBAL_SESSION_ID,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
    };
    this.sessions.set(GLOBAL_SESSION_ID, state);
    return state;
  }

  private onCoreEvent(event: GlobalEvent): void {
    if (event.type === 'event.session.created') {
      const payload = sessionCreatedPayload(event.payload);
      if (payload === undefined) return;
      // Forward creation to every connection (`isGlobalEvent` already matches
      // `event.session.*`), routed through the real session so the envelope
      // carries the real `session_id` (not the `__global__` watermark) — exactly
      // like `session.meta.updated` below. Without this, clients that didn't
      // issue the create never learn the session exists, so a later
      // `sessionStatusChanged` reducer is a no-op for the unknown session and
      // kimi-web's Stop button (gated on session.status === 'running') never
      // renders. Mirrors v1's `isGlobalSessionEvent` broadcast of creation.
      void this.dispatchSessionEvent(payload.sessionId, {
        type: 'event.session.created',
        session: payload.session,
        agentId: 'main',
        sessionId: payload.sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(payload.sessionId, 'event.session.created', error),
      );
      return;
    }
    if (event.type === 'session.meta.updated') {
      const payload = sessionMetaUpdatedPayload(event.payload);
      if (payload === undefined) return;
      // The originating session id travels on the core payload (the v1 protocol
      // event itself carries only title/patch). Recover it so the WS envelope is
      // addressed to the real session: routing through the global state would
      // stamp `session_id = '__global__'`, and clients would fail to match the
      // event to any sidebar session — so the auto-generated title (or a rename
      // from another client) would never appear. `isGlobalEvent` still fans the
      // dispatch out to every connection, so non-subscribed clients stay in sync
      // exactly like v1.
      const sessionId = sessionMetaUpdatedSessionId(event.payload);
      if (sessionId === undefined) return;
      void this.dispatchSessionEvent(sessionId, {
        type: 'session.meta.updated',
        ...payload,
        agentId: 'main',
        sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(sessionId, 'session.meta.updated', error),
      );
    }
  }

  private async dispatchGlobal(event: Event): Promise<void> {
    const state = await this.ensureGlobalState();
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
  }

  /**
   * Dispatch an event through a real session's state so the WS envelope carries
   * the real `session_id` (not the global `'__global__'` watermark). Used for
   * session-scoped core events that must still fan out to every connection
   * (e.g. `session.meta.updated`); `isGlobalEvent` keeps the fan-out global.
   */
  private async dispatchSessionEvent(sessionId: string, event: Event): Promise<void> {
    let state: SessionState | undefined;
    try {
      state = await this.ensureState(sessionId);
    } catch (error) {
      // The session's core scope can be disposed mid-dispatch during shutdown;
      // the event is moot once its session is gone. Same guard as ensureState
      // applies around attach*, extended to the accessor reads above it.
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return;
      }
      throw error;
    }
    if (state === undefined) return;
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
  }

  /**
   * Bridge the core's session work aggregate (`ISessionActivityView`) onto
   * the v1 `event.session.work_changed` frame. The view owns the fold and
   * its change dedup; the edge only schedules the wire emission. Every cause
   * except `turn_ended` emits immediately. A `turn_ended` change must land
   * after the matching `turn.ended` frame, but the agent bus fires
   * full-stream subscribers (the edge's own handler) before per-type ones
   * (the activity view chain that reports this change) — so the state is
   * buffered and flushed from a microtask: the microtask runs after the
   * whole synchronous publish, by which time the `turn.ended` frame is
   * already enqueued on the session queue, and the emission can never be
   * stranded behind a flush that already ran.
   */
  private attachWorkView(session: ISessionScopeHandle, state: SessionState): void {
    const workView = session.accessor.get(ISessionActivityView);
    // The view is a Delayed service: an event subscription alone never
    // constructs it — touch `state()` so the fold is live from activation on.
    workView.state();
    state.lifecycleDisposables.push(
      workView.onDidChange(({ state: work, cause }) => {
        if (cause === 'turn_ended') {
          state.deferredWork = work;
          queueMicrotask(() => {
            // The session may have been torn down meanwhile.
            if (this.sessions.get(state.sessionId) !== state) return;
            this.flushDeferredWork(state);
          });
          return;
        }
        this.flushDeferredWork(state);
        this.enqueueWorkChanged(state, work);
      }),
    );
  }

  private flushDeferredWork(state: SessionState): void {
    const deferred = state.deferredWork;
    if (deferred === undefined) return;
    state.deferredWork = undefined;
    this.enqueueWorkChanged(state, deferred);
  }

  private attachAgents(sessionId: string, session: ISessionScopeHandle, state: SessionState): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IAgentScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      state.agentDisposables.set(handle.id, this.attachAgent(sessionId, handle));
    };
    for (const handle of agents.list()) subscribeAgent(handle);
    state.lifecycleDisposables.push(
      agents.onDidCreate((handle) => {
        subscribeAgent(handle);
        // Session-grained lifecycle fact, ahead of any of the agent's own
        // events: `onDidCreate` fires before the agent's eager services
        // ignite, so this enqueue lands first in the queue.
        this.enqueueDurable(state, {
          type: 'agent.created',
          agentId: handle.id,
          sessionId,
        });
      }),
      agents.onDidDispose((agentId) => {
        const d = state.agentDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          state.agentDisposables.delete(agentId);
          this.enqueueDurable(state, {
            type: 'agent.disposed',
            agentId,
            sessionId,
          });
        }
      }),
    );
  }

  private attachAgent(sessionId: string, handle: IAgentScopeHandle): IDisposable {
    const eventBus = handle.accessor.get(IEventBus);
    let lastLegacyStatus: string | undefined;
    const emitLegacyStatus = (): void => {
      const snapshot = readLegacyStatus(handle);
      if (snapshot === undefined) return;
      const key = JSON.stringify(snapshot);
      if (key === lastLegacyStatus) return;
      lastLegacyStatus = key;
      this.onAgentEvent(sessionId, MAIN_AGENT_ID, {
        type: 'agent.status.updated',
        ...snapshot,
      });
    };
    const disposables: IDisposable[] = [
      eventBus.subscribe((event) => {
        let projected = event;
        if (event.type === 'agent.status.updated') {
          const snapshot = readLegacyStatus(handle);
          if (snapshot !== undefined) {
            lastLegacyStatus = JSON.stringify(snapshot);
            projected = { ...event, ...snapshot };
          }
        }
        if (handle.id === MAIN_AGENT_ID && event.type === 'context.spliced') {
          emitLegacyStatus();
        }
        this.onAgentEvent(sessionId, handle.id, projected);
      }),
    ];

    return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
  }

  private onAgentEvent(sessionId: string, agentId: string, event: DomainEvent): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;

    // Map the native v2 activity state to the legacy v1 `agent.status.updated`
    // phase slice at the edge, so the v1 channel picks up the corrected
    // semantics (approval-set, idle-after-ended) without the core engine
    // carrying v1 compatibility. The core's own `agent.status.updated` phase
    // slice is dropped here to avoid duplicate phase events; other slices
    // (usage / context / plan / swarm) flow through unchanged. The session's
    // work aggregate (busy / last_turn_reason) is the core
    // `ISessionActivityView`'s job — see attachWorkView.
    if (event.type === 'agent.activity.updated') {
      const snapshot = event as unknown as AgentActivityState;
      const phase = toLegacyPhase(snapshot);
      if (phase !== undefined) {
        const wireEvent = {
          type: 'agent.status.updated',
          phase,
          agentId,
          sessionId,
        } as unknown as Event;
        state.queue = state.queue
          .then(() => this.dispatch(state, wireEvent, true))
          .catch((error: unknown) => this.logDispatchDropped(state.sessionId, wireEvent.type, error));
      }
      return;
    }
    if (
      event.type === 'agent.status.updated' &&
      (event as { phase?: unknown }).phase !== undefined
    ) {
      return;
    }

    // The migrated agent events are AgentEvent-shaped by construction (they were
    // ported from the former `record.signal(agentEvent)` call sites); the declared
    // `DomainEventMap` payload types are deliberately wider than the protocol
    // contract, hence the assertion via `unknown`.
    const wireEvent = { ...event, agentId, sessionId } as unknown as Event;
    const volatile = isVolatileSignal(event.type);
    state.queue = state.queue
      .then(() => this.dispatch(state, wireEvent, volatile))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, wireEvent.type, error));
    // v1 wire compat: fan the legacy `background.task.*` spelling out next to
    // the native `task.*` event (see `legacyTaskEvent`) so unchanged v1 clients
    // keep working while v2-shaped clients ignore the alias. Same volatility as
    // the native event so replay/journal/filter stay coherent between the two.
    const legacy = legacyTaskEvent(event, agentId, sessionId);
    if (legacy !== undefined) {
      state.queue = state.queue
        .then(() => this.dispatch(state, legacy, volatile))
        .catch((error: unknown) => this.logDispatchDropped(state.sessionId, legacy.type, error));
    }
  }

  /**
   * Bridge the session's interaction kernel (approvals / questions) onto the
   * v1 event stream. The kernel only emits in-process notifications
   * (`onDidChangePending` / `onDidResolve`), so the v1 protocol events are
   * synthesized here.
   */
  private attachInteractions(
    sessionId: string,
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const interactions = session.accessor.get(ISessionInteractionService);
    // Seed silently: interactions already pending at activation are surfaced
    // by the snapshot route (`pending_questions` / `pending_approvals`).
    for (const i of interactions.listPending()) {
      state.knownInteractions.set(i.id, { kind: i.kind, agentId: i.origin.agentId ?? 'main' });
    }
    state.lifecycleDisposables.push(
      interactions.onDidChangePending(() => {
        // The session's pending-interaction work slice is recomputed by the
        // core `ISessionActivityView` off this same notification — here only
        // the protocol events for newly pending requests are synthesized.
        for (const i of interactions.listPending()) {
          if (state.knownInteractions.has(i.id)) continue;
          state.knownInteractions.set(i.id, {
            kind: i.kind,
            agentId: i.origin.agentId ?? 'main',
          });
          const event = interactionRequestedEvent(i, sessionId);
          if (event !== undefined) {
            this.enqueueDurable(state, event);
          }
        }
      }),
      interactions.onDidResolve(({ id, response }) => {
        const known = state.knownInteractions.get(id);
        if (known === undefined) return;
        state.knownInteractions.delete(id);
        const event = interactionResolvedEvent(known.kind, id, response, sessionId, known.agentId);
        if (event !== undefined) {
          this.enqueueDurable(state, event);
        }
      }),
    );
  }

  private enqueueDurable(state: SessionState, event: Event): void {
    state.queue = state.queue
      .then(() => this.dispatch(state, event, false))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
  }

  /**
   * Emit `event.session.work_changed` for one aggregate change announced by
   * the core `ISessionActivityView` (the view already dedups — every call
   * here is a real tuple change).
   */
  private enqueueWorkChanged(state: SessionState, work: SessionActivityState): void {
    state.queue = state.queue
      .then(() =>
        this.dispatch(
          state,
          {
            type: 'event.session.work_changed',
            busy: work.busy,
            main_turn_active: work.mainTurnActive,
            pending_interaction: work.pendingInteraction,
            last_turn_reason: work.lastTurnReason,
            agentId: 'main',
            sessionId: state.sessionId,
          } as Event,
          false,
        ),
      )
      .catch((error: unknown) =>
        this.logDispatchDropped(state.sessionId, 'event.session.work_changed', error),
      );
  }

  /**
   * Log a rejected `dispatchSessionEvent` promise — the session's scope was
   * torn down mid-dispatch, or a non-disposed error escaped `ensureState`.
   */
  private logDispatchError(sessionId: string, eventType: string, error: unknown): void {
    const logger = this.opts.logger;
    if (logger === undefined) return;
    if (logger.error !== undefined) {
      logger.error({ sessionId, eventType, err: error }, 'session event dispatch failed');
    } else {
      logger.warn({ sessionId, eventType, err: error }, 'session event dispatch failed');
    }
  }

  /**
   * A queued dispatch rejected: the event is permanently lost (and, for durable
   * events, the seq is skipped). Warn instead of swallowing it silently.
   */
  private logDispatchDropped(sessionId: string, eventType: string, error: unknown): void {
    this.opts.logger?.warn(
      { sessionId, eventType, err: error },
      'session event dispatch failed; event dropped',
    );
  }

  private async dispatch(state: SessionState, event: Event, volatile: boolean): Promise<void> {
    const { journal, tracker, roster, tail, targets, sessionId } = state;
    const annotation = tracker.apply(sessionId, event);
    // Same queue-discipline as the in-flight tracker: snapshot rebuilds must
    // see exactly the roster as of the durable watermark.
    roster.apply(sessionId, event);

    let envelope: EventEnvelope;
    if (volatile) {
      envelope = this.buildEnvelope(journal.seq, sessionId, event, {
        epoch: journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
      });
    } else {
      const seq = journal.nextSeq();
      envelope = this.buildEnvelope(seq, sessionId, event, { epoch: journal.epoch });
      journal.append(seq, envelope);
      tail.push({ seq, envelope });
      while (tail.length > this.maxBufferSize) tail.shift();
    }

    if (isGlobalEvent(event.type)) {
      // Global events (session/workspace/config) are not agent events — fan
      // out to every established connection (globalTargets) union every
      // subscribed target, regardless of any agent filter. The union keeps
      // targets that subscribed without a global registration (test doubles,
      // minimal embeds) on the legacy delivery path.
      const recipients = new Set<BroadcastTarget>(this.globalTargets);
      for (const target of this.allTargets()) recipients.add(target);
      for (const target of recipients) {
        try {
          target.send(envelope, 'immediate');
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    } else {
      for (const [target, sub] of targets) {
        if (!matchesAgentFilter(envelope, sub.agentFilter)) continue;
        // Transcript subscribers already receive the projected equivalent of
        // this event — drop the duplicate session_event on their send view.
        if (suppressedByTranscript(envelope, sub.transcriptGrades)) continue;
        try {
          target.send(envelope);
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    }
  }

  private buildEnvelope(
    seq: number,
    sessionId: string,
    event: Event,
    extras: { epoch?: string; volatile?: boolean; offset?: number },
  ): EventEnvelope {
    return {
      type: event.type,
      seq,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: event,
      ...extras,
    };
  }

  private *allTargets(): Iterable<BroadcastTarget> {
    for (const state of this.sessions.values()) {
      for (const target of state.targets.keys()) yield target;
    }
  }
}
