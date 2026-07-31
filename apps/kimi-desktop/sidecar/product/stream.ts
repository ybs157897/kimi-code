/**
 * Product stream hub — owns the per-(sessionId, agentId) event-stream state the
 * desktop transport needs for reconnect convergence (docs/plan/
 * desktop-v2-full-integration.md, "P0：补齐事件一致性"):
 *
 *  - a **stable epoch** minted once per key and reused across every subscribe,
 *  - a **monotonic seq** that survives detach/re-attach (not reset per
 *    subscription, unlike the first-slice projector), and
 *  - a **bounded journal** of recently projected frames so a reconnecting
 *    subscriber can be caught up point-to-point instead of losing the tail.
 *
 * `getSessionSnapshot` reads the same `(epoch, seq)` watermark (via
 * `watermark()`), so the snapshot and the subsequent subscription share one
 * cursor space: the client seeds at `as_of_seq` and resumes from it.
 *
 * The hub owns exactly one underlying `ProductProjector` subscription per key,
 * ref-counted by its listeners: the klient subscription attaches on the first
 * subscriber and detaches when the last one leaves. It stamps seq, appends to
 * the journal, and fans out to every current listener. This mirrors kap-server's
 * `TranscriptService` op-batch journal (bounded, dies with the process), scoped
 * to the desktop product wire.
 */

import type { IDisposable } from '@moonshot-ai/klient';

import { ulid } from './builders.js';
import type { ProductProjector } from './projector.js';
import type { ProductFrame, WireEvent, WireResyncRequired } from './wire.js';

/** Default retained-frame count per stream. Bounded so the journal cannot grow
 *  without limit for a long-lived, chatty session. */
const DEFAULT_JOURNAL_CAPACITY = 1024;

/**
 * How long a suspended stream keeps its underlying projector + journal alive
 * after the last listener leaves (e.g. an IPC disconnect), so a reconnect can
 * be caught up point-to-point from the journal instead of a full resync. After
 * the window a truly-abandoned stream releases the projector for good.
 */
const SUSPEND_KEEPALIVE_MS = 5 * 60 * 1000;

/** A resume cursor carried on a product subscription (from the listen arg). */
export interface ProductStreamCursor {
  /** The epoch the caller last observed; a mismatch forces a resync. */
  epoch?: string;
  /** The last seq the caller received; replay everything after it. */
  afterSeq?: number;
}

interface JournalEntry {
  readonly seq: number;
  readonly event: WireEvent;
}

interface StreamState {
  readonly sessionId: string;
  readonly agentId: string;
  readonly epoch: string;
  seq: number;
  readonly journal: JournalEntry[];
  readonly listeners: Set<(frame: ProductFrame) => void>;
  underlying: IDisposable | undefined;
  /** Pending release of a suspended stream (see SUSPEND_KEEPALIVE_MS). */
  idleTimer: NodeJS.Timeout | undefined;
}

/**
 * A live product subscription. `dispose()` releases the listener AND the
 * underlying projector when it was the last one (explicit unsubscribe);
 * `suspend()` removes only the listener — the projector keeps journaling
 * through the keepalive window so a reconnect replays the disconnected span.
 */
export interface ProductStreamListen extends IDisposable {
  suspend(): void;
}

type ResumePlan =
  | { readonly kind: 'live' }
  | { readonly kind: 'replay'; readonly replay: readonly JournalEntry[] }
  | { readonly kind: 'resync'; readonly reason: WireResyncRequired['payload']['reason'] };

export class ProductStreamHub {
  private readonly streams = new Map<string, StreamState>();

  constructor(
    private readonly projector: ProductProjector,
    private readonly journalCapacity: number = DEFAULT_JOURNAL_CAPACITY,
  ) {}

  private static key(sessionId: string, agentId: string): string {
    return `${sessionId}::${agentId}`;
  }

  /** Create-or-get the stream state, pinning a stable epoch for the key. */
  private ensure(sessionId: string, agentId: string): StreamState {
    const key = ProductStreamHub.key(sessionId, agentId);
    let state = this.streams.get(key);
    if (state === undefined) {
      state = {
        sessionId,
        agentId,
        epoch: ulid('ep_'),
        seq: 0,
        journal: [],
        listeners: new Set(),
        underlying: undefined,
        idleTimer: undefined,
      };
      this.streams.set(key, state);
    }
    return state;
  }

  /**
   * The current watermark for a key, pinning its epoch so a snapshot taken now
   * and a subscription started later share the same cursor space. Reading it
   * for a never-seen key creates a fresh stream at `{ epoch, asOfSeq: 0 }`.
   */
  watermark(sessionId: string, agentId: string): { epoch: string; asOfSeq: number } {
    const state = this.ensure(sessionId, agentId);
    return { epoch: state.epoch, asOfSeq: state.seq };
  }

  /** Stamp seq, append to the bounded journal, and fan out one projected frame. */
  private ingest(state: StreamState, draft: WireEvent): void {
    const seq = ++state.seq;
    const event = { ...draft, seq } as WireEvent;
    state.journal.push({ seq, event });
    if (state.journal.length > this.journalCapacity) {
      state.journal.splice(0, state.journal.length - this.journalCapacity);
    }
    // Snapshot the listener set: a consumer that disposes mid-fan-out must not
    // mutate the set we are iterating, and one broken consumer must not stop
    // delivery to the rest.
    for (const listener of [...state.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken consumer must not take down the stream.
      }
    }
  }

  /** Attach the single underlying projector subscription (idempotent per key). */
  private attachUnderlying(state: StreamState): void {
    if (state.underlying !== undefined) return;
    state.underlying = this.projector.subscribe(state.sessionId, state.agentId, (draft) => {
      this.ingest(state, draft);
    });
  }

  /** Fully release the underlying projector and cancel any pending idle timer. */
  private releaseUnderlying(state: StreamState): void {
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.underlying !== undefined) {
      state.underlying.dispose();
      state.underlying = undefined;
    }
  }

  /**
   * Subscribe a consumer, optionally resuming from a cursor. The consumer first
   * receives its catch-up — replayed journal frames, or a single
   * `resync_required` control frame when the journal cannot cover the cursor —
   * then live frames. Returns a listen handle whose `dispose()` detaches the
   * consumer and, once the last listener leaves, releases the underlying klient
   * subscription; `suspend()` detaches only the consumer so the underlying
   * keeps journaling through the keepalive window (IPC disconnect recovery).
   */
  subscribe(
    sessionId: string,
    agentId: string,
    cursor: ProductStreamCursor | undefined,
    push: (frame: ProductFrame) => void,
  ): ProductStreamListen {
    const state = this.ensure(sessionId, agentId);
    if (state.idleTimer !== undefined) {
      // A suspended stream is being re-subscribed — cancel its pending release.
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }

    // Resolve the catch-up BEFORE registering the live listener, so a frame
    // arriving during attach cannot slip ahead of the replayed prefix.
    const plan = this.planResume(state, cursor);
    if (plan.kind === 'resync') {
      push(this.resyncFrame(state, plan.reason));
    } else if (plan.kind === 'replay') {
      for (const entry of plan.replay) push(entry.event);
    }

    state.listeners.add(push);
    this.attachUnderlying(state);

    let disposed = false;
    const detach = (keepUnderlying: boolean): void => {
      if (disposed) return;
      disposed = true;
      state.listeners.delete(push);
      if (state.listeners.size > 0) return;
      if (keepUnderlying) {
        // Suspended: the journal must keep collecting through the disconnect
        // window so a reconnect can be caught up (or resync when it overflows).
        state.idleTimer = setTimeout(() => this.releaseUnderlying(state), SUSPEND_KEEPALIVE_MS);
        state.idleTimer.unref?.();
      } else {
        this.releaseUnderlying(state);
      }
    };
    return {
      dispose: () => detach(false),
      suspend: () => detach(true),
    };
  }

  private planResume(state: StreamState, cursor: ProductStreamCursor | undefined): ResumePlan {
    // No cursor → go live from the current head (history comes from the snapshot).
    if (cursor === undefined || cursor.afterSeq === undefined) return { kind: 'live' };
    // Epoch mismatch → the stream restarted; the caller's seq is meaningless.
    if (cursor.epoch !== undefined && cursor.epoch !== state.epoch) {
      return { kind: 'resync', reason: 'epoch_changed' };
    }
    const { afterSeq } = cursor;
    // Already current (or ahead, e.g. a stale higher cursor) → nothing to replay.
    if (afterSeq >= state.seq) return { kind: 'live' };
    const earliest = state.journal[0]?.seq;
    // Journal empty, or its oldest retained frame is past afterSeq+1 → the gap
    // between the cursor and the journal cannot be bridged incrementally.
    if (earliest === undefined || earliest > afterSeq + 1) {
      return { kind: 'resync', reason: 'buffer_overflow' };
    }
    return { kind: 'replay', replay: state.journal.filter((entry) => entry.seq > afterSeq) };
  }

  private resyncFrame(
    state: StreamState,
    reason: WireResyncRequired['payload']['reason'],
  ): WireResyncRequired {
    return {
      type: 'resync_required',
      timestamp: new Date().toISOString(),
      payload: {
        session_id: state.sessionId,
        reason,
        current_seq: state.seq,
        epoch: state.epoch,
      },
    };
  }
}
