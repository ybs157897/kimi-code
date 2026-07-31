import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  EMPTY_AGENT_STATE,
  type AgentState,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import { useConnection } from '../../connection';
import { AuditTrail } from '../../audit/trail';
import { fetchTranscriptOps, fetchTranscriptPage, TRANSCRIPT_PAGE_SIZE } from '../../transcript/api';
import {
  createCoalescedRunner,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from '../../transcript/store';
import { TranscriptWs } from '../../transcript/ws';

const noopSubscribe = () => () => {};

export interface TranscriptChannel {
  /** Null until the effect has created the store (pre-ready / no session). */
  readonly store: TranscriptChatStore | null;
  readonly state: AgentState;
  /** Records every step that built the store (audit panel data source). */
  readonly trail: AuditTrail | null;
  /** True once the initial REST page load succeeded. */
  readonly loaded: boolean;
  /** Set when the initial/refresh load failed (e.g. server without transcript). */
  readonly loadError: unknown;
}

/**
 * Owns the store, the REST load/refresh pipeline, and the WS delta
 * subscription for one (sessionId, agentId) pair.
 */
export function useTranscriptChannel(
  sessionId: string | null,
  agentId: string,
  ready: boolean,
  captureAnchor: () => void,
): TranscriptChannel {
  const { baseUrl, config } = useConnection();
  const token = config.token.trim();
  const [channel, setChannel] = useState<{ store: TranscriptChatStore; trail: AuditTrail } | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    if (!ready || sessionId === null) return;
    const store = new TranscriptChatStore();
    const trail = new AuditTrail();
    const authToken = token === '' ? undefined : token;
    let disposed = false;
    /** While a REST reload / catch-up is in flight, WS ops are buffered, then flushed. */
    let fetching = true;
    let buffer: TranscriptOperation[] = [];
    /** Max batch seq seen while buffering (folded into the watermark on flush). */
    let bufferedSeq: number | undefined;
    /**
     * Op-batch watermark: the store is known to include every batch with
     * seq <= lastSeq. Sourced from REST page watermarks and applied batch
     * seqs; `undefined` until a sequenced server provides one (legacy
     * servers never do — every recovery then falls back to full refreshes).
     */
    let lastSeq: number | undefined;
    /** Cursor of the in-flight recover fetch, paired with `onPageApplied`. */
    let recoverBefore: string | undefined;
    /** True once the initial page load succeeded (gates reset-driven catch-up). */
    let seeded = false;

    const noteSeq = (seq: number | undefined): void => {
      if (seq === undefined) return;
      lastSeq = lastSeq === undefined ? seq : Math.max(lastSeq, seq);
    };

    const flushBuffer = (): void => {
      fetching = false;
      if (buffer.length > 0) {
        const flushed = buffer;
        store.applyOps(flushed);
        trail.recordOps(flushed, 'flushed', undefined, store.getState());
        noteSeq(bufferedSeq);
      }
      buffer = [];
      bufferedSeq = undefined;
    };

    /** Page (re)load body shared by the full refresh and the catch-up fallback. */
    const reloadPages = async (): Promise<void> => {
      // The window's oldest turn is the re-cover anchor: after a refresh the
      // server window may have shifted, and only re-loading up to THIS turn
      // preserves the previously loaded history.
      const prevOldest = oldestTurnId(store.getState().items);
      if (prevOldest !== undefined) captureAnchor();
      const newest = await fetchTranscriptPage({
        baseUrl,
        token: authToken,
        sessionId,
        agentId,
        pageSize: TRANSCRIPT_PAGE_SIZE,
      });
      if (disposed) return;
      store.applyPage(newest, { replace: true });
      trail.recordRest({ pageSize: TRANSCRIPT_PAGE_SIZE }, 'replace', newest, store.getState());
      lastSeq = newest.seq;
      // Re-cover the previously loaded window for refreshes (a no-op on the
      // initial load, where there is no previous oldest turn).
      await recoverLoadedWindow(
        store,
        prevOldest,
        (beforeTurn) => {
          recoverBefore = beforeTurn;
          return fetchTranscriptPage({
            baseUrl,
            token: authToken,
            sessionId,
            agentId,
            beforeTurn,
            pageSize: TRANSCRIPT_PAGE_SIZE,
          });
        },
        () => disposed,
        (page) => {
          trail.recordRest(
            { beforeTurn: recoverBefore, pageSize: TRANSCRIPT_PAGE_SIZE },
            'prepend',
            page,
            store.getState(),
          );
        },
      );
      if (!disposed) {
        seeded = true;
        setLoaded(true);
        setLoadError(null);
      }
    };

    /** Full-state (re)load: the legacy recovery path and the initial load. */
    const refresh = createCoalescedRunner(async (): Promise<void> => {
      fetching = true;
      buffer = [];
      bufferedSeq = undefined;
      try {
        await reloadPages();
      } catch (error) {
        if (!disposed) setLoadError(error);
      } finally {
        flushBuffer();
      }
    });

    /**
     * Targeted catch-up: fetch exactly the op batches after our watermark
     * (`GET .../transcript/ops?since_seq=`). Falls back to a full page
     * reload on a legacy server (no seq / endpoint missing), a journal that
     * no longer covers the gap (`complete: false`), or a fetch failure.
     */
    const catchUp = createCoalescedRunner(async (): Promise<void> => {
      if (lastSeq === undefined) {
        refresh();
        return;
      }
      fetching = true;
      buffer = [];
      bufferedSeq = undefined;
      try {
        const res = await fetchTranscriptOps({
          baseUrl,
          token: authToken,
          sessionId,
          agentId,
          sinceSeq: lastSeq,
        });
        if (disposed) return;
        if (!res.complete) {
          await reloadPages();
        } else {
          for (const batch of res.batches) {
            store.applyOps(batch.ops);
            trail.recordOps(batch.ops, 'catchup', undefined, store.getState());
          }
          noteSeq(res.latestSeq);
        }
      } catch {
        try {
          await reloadPages();
        } catch (error) {
          if (!disposed) setLoadError(error);
        }
      } finally {
        flushBuffer();
      }
    });

    const ws = new TranscriptWs({
      url: baseUrl,
      token: authToken,
      sessionId,
      agentId,
      getSince: () => lastSeq,
      handlers: {
        onOps: (aid, ops, meta) => {
          if (aid !== agentId) return;
          if (fetching) {
            buffer.push(...ops);
            if (meta?.seq !== undefined) {
              bufferedSeq = Math.max(bufferedSeq ?? 0, meta.seq);
            }
            trail.recordOps(ops, 'buffered', meta?.at, store.getState());
            return;
          }
          // Seq gap: the store is behind by at least one batch. Catch up
          // point-to-point instead of applying on a stale base (appends are
          // offset-placed and would surface a gap anyway).
          if (meta?.seq !== undefined && lastSeq !== undefined && meta.seq > lastSeq + 1) {
            catchUp();
            return;
          }
          store.applyOps(ops);
          trail.recordOps(ops, 'live', meta?.at, store.getState());
          noteSeq(meta?.seq);
        },
        onReset: (_aid, snapshot, hasMoreOlder, meta) => {
          trail.recordReset(snapshot, hasMoreOlder, meta?.at, store.getState());
          // Sequenced mode only: a reset after seeding means the server could
          // not replay from our `transcript_since` cursor (journal truncated)
          // — catch up, which itself falls back to a full reload when the seq
          // window is gone. On legacy servers (no watermark) resets are
          // routine per-subscribe noise and stay ignored, as before.
          if (seeded && lastSeq !== undefined) catchUp();
        },
        onResyncRequired: () => {
          trail.recordEvent('resync', undefined, store.getState());
          catchUp();
        },
        onReconnected: () => {
          trail.recordEvent('ack-refresh', undefined, store.getState());
          catchUp();
        },
      },
    });
    store.onGap = () => {
      trail.recordEvent('gap', undefined, store.getState());
      catchUp();
    };
    setChannel({ store, trail });
    setLoaded(false);
    setLoadError(null);
    refresh();
    return () => {
      disposed = true;
      ws.close();
      setChannel(null);
    };
  }, [sessionId, agentId, ready, baseUrl, token, captureAnchor]);

  const state = useSyncExternalStore(
    channel?.store.subscribe ?? noopSubscribe,
    () => channel?.store.getState() ?? EMPTY_AGENT_STATE,
  );
  return { store: channel?.store ?? null, state, trail: channel?.trail ?? null, loaded, loadError };
}
