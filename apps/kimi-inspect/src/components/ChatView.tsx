/**
 * Main view — the conversation of the active session + agent, rendered from
 * the transcript surface (`/api/v1`):
 *
 *  - FULL state comes from the REST transcript API only: the initial load
 *    reads the newest page, a full refresh re-reads from the tail backwards
 *    until the previously loaded window is re-covered, and "Load earlier
 *    turns" pages further with a `before_turn` cursor.
 *  - The WS channel (`/api/v1/ws`) is a DELTA channel only: `transcript.ops`
 *    at `delta` grade; `transcript.reset` snapshots are ignored. Ops are
 *    buffered while a REST refresh is in flight and flushed onto the fresh
 *    pages — idempotent upserts and offset-placed appends make that converge.
 *  - Loss signals (`resync_required`, append gap, socket reconnect) trigger
 *    a full REST refresh; nothing is resynced from the socket itself.
 *
 * Rendering is turn-granular (turn → step → frame) and typed entirely by the
 * transcript data model. Prompts/cancels go through the `IAgentRPCService`
 * over the debug RPC surface (`/api/v1/debug`); the running indicator
 * derives from transcript state (`meta.activity` / running turns).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import { itemId } from '@moonshot-ai/transcript';

import { useConnection } from '../connection';
import { AuditTrail } from '../audit/trail';
import { fetchTranscriptPage, TRANSCRIPT_PAGE_SIZE } from '../transcript/api';
import { oldestTurnId } from '../transcript/store';
import { ActionButton, Badge, ErrorLine } from '../ui';
import { InteractionEntityView } from './chat-view/InteractionEntityView';
import { collectToolCallIds, ItemView } from './chat-view/items';
import { SessionContext } from './chat-view/SessionContext';
import { useTranscriptChannel } from './chat-view/useTranscriptChannel';

export function ChatView({
  sessionId,
  agentId,
  ready,
  onTrailChange,
}: {
  sessionId: string | null;
  agentId: string;
  ready: boolean;
  /** Hands the audit trail of the current channel up to the app shell (the audit panel lives in the right dock, not inside this view). */
  onTrailChange?: (trail: AuditTrail | null) => void;
}) {
  const { klient, baseUrl, config } = useConnection();
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Distance from the scroll bottom captured before a prepend (restore anchor). */
  const anchorRef = useRef<number | null>(null);
  /** Whether the viewport was pinned to the bottom before the last update. */
  const stickBottomRef = useRef(true);

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null) anchorRef.current = el.scrollHeight - el.scrollTop;
  }, []);

  const { store, state, trail, loaded, loadError } = useTranscriptChannel(
    sessionId,
    agentId,
    ready,
    captureAnchor,
  );
  const items = state.items;

  // The audit panel is rendered by the app shell's right dock; report the
  // trail (null while no channel exists) so it can subscribe to it there.
  useEffect(() => {
    onTrailChange?.(trail);
  }, [onTrailChange, trail]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    if (sessionId === null || loadingOlder || store === null) return;
    const oldest = oldestTurnId(items);
    if (oldest === undefined) return;
    captureAnchor();
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const token = config.token.trim();
      const page = await fetchTranscriptPage({
        baseUrl,
        token: token === '' ? undefined : token,
        sessionId,
        agentId,
        beforeTurn: oldest,
        pageSize: TRANSCRIPT_PAGE_SIZE,
      });
      store.applyPage(page);
      trail?.recordRest(
        { beforeTurn: oldest, pageSize: TRANSCRIPT_PAGE_SIZE },
        'prepend',
        page,
        store.getState(),
      );
    } catch (error) {
      anchorRef.current = null;
      setOlderError(error);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Auto-paging: the top sentinel auto-loads the previous REST page when it
  // approaches the viewport (paused while a previous load failed — the retry
  // button re-arms it). This replaces any manual "load earlier" action.
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const hasMoreOlder = state.hasMoreOlder;
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (sentinel === null || root === null || olderError !== null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlderRef.current();
      },
      { root, rootMargin: '400px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasMoreOlder, loaded, olderError, loadingOlder]);

  const running =
    state.meta.activity === 'turn' ||
    items.some((item) => item.kind === 'turn' && item.state === 'running');

  // Interactions render inline at their anchor tool frame; entities without
  // an anchor (or whose anchor frame is outside the loaded window) collect
  // here and render floating at the bottom.
  const anchoredToolCallIds = collectToolCallIds(items);
  const unanchoredInteractions = [...state.interactions.values()].filter(
    (interaction) =>
      interaction.toolCallId === undefined || !anchoredToolCallIds.has(interaction.toolCallId),
  );
  const latestTodo = [...state.todos.values()].at(-1);

  const send = async () => {
    if (sessionId === null || input.trim() === '' || running) return;
    const text = input.trim();
    setInput('');
    setSendError(null);
    try {
      await klient
        .session(sessionId)
        .agent(agentId)
        .service(IAgentRPCService)
        .prompt({ input: [{ type: 'text', text }] });
      trail?.recordEvent('prompt', text, state);
    } catch (error) {
      setSendError(error);
    }
  };

  const cancel = async () => {
    if (sessionId === null) return;
    try {
      await klient.session(sessionId).agent(agentId).service(IAgentRPCService).cancel({});
      trail?.recordEvent('cancel', undefined, state);
    } catch (error) {
      setSendError(error);
    }
  };

  if (sessionId === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Select a session on the left to open its conversation.
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Loading session…
      </div>
    );
  }

  return (
    <SessionContext.Provider value={sessionId}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <span className="font-mono text-[11px] text-neutral-400">{sessionId}</span>
          <Badge tone="sky">agent: {agentId}</Badge>
          {running ? <Badge tone="amber">turn running</Badge> : <Badge tone="green">idle</Badge>}
          {state.pendingInteractions.size > 0 ? (
            <Badge tone="amber">{state.pendingInteractions.size} pending</Badge>
          ) : null}
        </div>
  
        <div className="flex-1 overflow-y-auto px-4 py-3" ref={scrollRef} onScroll={onScroll}>
          {state.hasMoreOlder ? (
            <div ref={topSentinelRef} className="mb-3 flex justify-center">
              <span className="text-[11px] text-neutral-600">
                {loadingOlder ? 'Loading earlier turns…' : ''}
              </span>
            </div>
          ) : null}
          {olderError !== null ? (
            <div className="mb-2">
              <ErrorLine error={olderError} />
              <div className="mt-1 flex justify-center">
                <ActionButton
                  onClick={() => {
                    setOlderError(null);
                    void loadOlder();
                  }}
                >
                  Retry loading earlier turns
                </ActionButton>
              </div>
            </div>
          ) : null}
          {loadError !== null ? (
            <div className="mb-2">
              <ErrorLine error={loadError} />
              <div className="mt-1 text-[11px] text-neutral-600">
                Failed to load the transcript — the server may be too old to expose the transcript
                API.
              </div>
            </div>
          ) : null}
          {items.length === 0 && loadError === null ? (
            <div className="text-[12px] text-neutral-600 italic">
              {loaded ? 'Empty transcript — send a prompt below.' : 'Loading transcript…'}
            </div>
          ) : null}
          {latestTodo !== undefined && latestTodo.items.length > 0 ? (
            <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
              <div className="mb-1 text-neutral-500">todo (latest)</div>
              {latestTodo.items.map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span className={entry.status === 'done' ? 'text-green-500' : entry.status === 'in_progress' ? 'text-sky-400' : 'text-neutral-600'}>
                    {entry.status === 'done' ? '✔' : entry.status === 'in_progress' ? '◐' : '□'}
                  </span>
                  <span className={entry.status === 'done' ? 'text-neutral-600 line-through' : 'text-neutral-300'}>
                    {entry.title}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {items.map((item) => (
            // Native virtual screen: the browser skips layout/paint for
            // off-screen items and remembers their last rendered size
            // (`auto` in contain-intrinsic-size), so long transcripts stay
            // cheap without a windowing library.
            <div
              key={itemId(item)}
              style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
            >
              <ItemView
                item={item}
                tasks={state.tasks}
                interactions={state.interactions}
                attachments={state.attachments}
              />
            </div>
          ))}
          {unanchoredInteractions.map((interaction) => (
            <InteractionEntityView key={interaction.interactionId} interaction={interaction} />
          ))}
        </div>
  
        <div className="border-t border-neutral-800 p-3">
          {sendError !== null ? (
            <div className="mb-2">
              <ErrorLine error={sendError} />
            </div>
          ) : null}
          <div className="flex gap-2">
            <textarea
              className="min-h-[40px] flex-1 resize-y rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-[13px] text-neutral-100 outline-none focus:border-sky-600"
              placeholder="Send a prompt to the active agent… (Enter to send, Shift+Enter for newline)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex flex-col gap-2">
              <ActionButton onClick={() => void send()} disabled={running || input.trim() === ''}>
                Send
              </ActionButton>
              <ActionButton onClick={() => void cancel()} danger disabled={!running}>
                Cancel
              </ActionButton>
            </div>
          </div>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
