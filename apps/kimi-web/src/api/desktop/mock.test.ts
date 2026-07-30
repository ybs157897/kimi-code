// Scenario: the browser-only desktop bridge mirrors product response/event
// contracts without a Go process. Exercises ProductCall/ProductSubscribe with
// no additional stubs. Run with `pnpm --filter @moonshot-ai/kimi-web test`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireSession } from '../daemon/wire';
import { MockDesktopBridge } from './mock';
import type { DesktopEventPayload, ProductEventPayload } from './types';

function types(events: DesktopEventPayload[]): string[] {
  return events.map((entry) => entry.event.type);
}

function productTypes(events: ProductEventPayload[]): string[] {
  return events.map((entry) => entry.event.type);
}

describe('MockDesktopBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Hello reports the mock transport', async () => {
    const bridge = new MockDesktopBridge();
    const pending = bridge.Hello();
    await vi.advanceTimersByTimeAsync(100);
    const hello = await pending;
    expect(hello['status']).toBe('ok');
    expect(hello['transport']).toBe('mock');
  });

  it('CreateSession registers a session that ListSessions returns', async () => {
    const bridge = new MockDesktopBridge();
    const pendingCreate = bridge.CreateSession();
    await vi.advanceTimersByTimeAsync(100);
    const handle = await pendingCreate;
    expect(handle.sessionId).toBeTruthy();
    expect(handle.agentId).toBe('main');

    const pendingList = bridge.ListSessions();
    await vi.advanceTimersByTimeAsync(100);
    const page = await pendingList;
    expect(page.items.map((item) => item.id)).toContain(handle.sessionId);
  });

  it('Submit streams a canned turn through the contract C envelope', async () => {
    const bridge = new MockDesktopBridge();
    const events: DesktopEventPayload[] = [];
    bridge.onEvent((payload) => events.push(payload));

    const pendingCreate = bridge.CreateSession();
    await vi.advanceTimersByTimeAsync(100);
    const handle = await pendingCreate;
    const agentId = handle.agentId ?? 'main';

    void bridge.Submit(handle.sessionId, agentId, 'hello');
    await vi.runAllTimersAsync();

    const seq = types(events);
    expect(seq[0]).toBe('turn.started');
    expect(seq[seq.length - 1]).toBe('turn.ended');
    expect(seq).toContain('assistant.delta');
    expect(seq).toContain('tool.call.started');
    expect(seq).toContain('tool.progress');
    expect(seq).toContain('tool.result');

    // Every frame carries the {sessionId,agentId,event} envelope (contract C).
    for (const payload of events) {
      expect(payload.sessionId).toBe(handle.sessionId);
      expect(payload.agentId).toBe(agentId);
    }

    const ended = events[events.length - 1]?.event;
    if (ended?.type !== 'turn.ended') throw new Error('expected turn.ended');
    expect(ended.reason).toBe('completed');
    expect(typeof ended.durationMs).toBe('number');
  });

  it('Cancel aborts the in-flight canned turn', async () => {
    const bridge = new MockDesktopBridge();
    const events: DesktopEventPayload[] = [];
    bridge.onEvent((payload) => events.push(payload));

    const pendingCreate = bridge.CreateSession();
    await vi.advanceTimersByTimeAsync(100);
    const handle = await pendingCreate;

    void bridge.Submit(handle.sessionId, handle.agentId ?? 'main', 'hello');
    // Past turn.started (30ms) but well before the sequence finishes.
    await vi.advanceTimersByTimeAsync(100);
    expect(types(events)[0]).toBe('turn.started');
    const countBefore = events.length;

    void bridge.Cancel(handle.sessionId, handle.agentId ?? 'main');
    const cancelled = events[events.length - 1]?.event;
    if (cancelled?.type !== 'turn.ended') throw new Error('expected turn.ended');
    expect(cancelled.reason).toBe('cancelled');

    // The scheduled canned frames were cleared — nothing else fires.
    await vi.runAllTimersAsync();
    expect(events.length).toBe(countBefore + 1);
  });

  it('onEvent unsubscribe stops delivery', async () => {
    const bridge = new MockDesktopBridge();
    const events: DesktopEventPayload[] = [];
    const off = bridge.onEvent((payload) => events.push(payload));
    off();

    const pendingCreate = bridge.CreateSession();
    await vi.advanceTimersByTimeAsync(100);
    const handle = await pendingCreate;
    void bridge.Submit(handle.sessionId, handle.agentId ?? 'main', 'hello');
    await vi.runAllTimersAsync();
    expect(events).toHaveLength(0);
  });
});

describe('MockDesktopBridge product surface (contracts E + F)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function call<T>(bridge: MockDesktopBridge, method: string, args: unknown[]): Promise<T> {
    const pending = bridge.ProductCall(method, JSON.stringify(args));
    await vi.advanceTimersByTimeAsync(100);
    // ProductCall returns the raw kap-server WireEnvelope (contract E); unwrap
    // it exactly like WailsKimiWebApi.call does (code 0 → data).
    const envelope = JSON.parse(await pending) as { code: number; msg: string; data: T };
    expect(envelope.code).toBe(0);
    return envelope.data;
  }

  it('createSession returns a kimi-web WireSession; listSessions pages it', async () => {
    const bridge = new MockDesktopBridge();
    const session = await call<WireSession>(bridge, 'createSession', [{ metadata: { cwd: '/mock' }, title: 'Demo' }]);
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('Demo');
    expect(session.metadata.cwd).toBe('/mock');
    expect(session.usage).toBeTruthy();

    const page = await call<{ items: WireSession[]; has_more: boolean }>(bridge, 'listSessions', [{}]);
    expect(page.has_more).toBe(false);
    expect(page.items.map((item) => item.id)).toContain(session.id);
  });

  it('submitPrompt streams canned WireEvents through the product envelope', async () => {
    const bridge = new MockDesktopBridge();
    const events: ProductEventPayload[] = [];
    bridge.onProductEvent((payload) => events.push(payload));

    const session = await call<WireSession>(bridge, 'createSession', [{ metadata: { cwd: '/mock' } }]);
    await bridge.ProductSubscribe(session.id, 'main');

    const result = await call<{ prompt_id: string; user_message_id: string; status: string }>(
      bridge,
      'submitPrompt',
      [session.id, { content: [{ type: 'text', text: 'hello' }] }],
    );
    expect(result.prompt_id).toBeTruthy();
    expect(result.status).toBe('running');

    await vi.runAllTimersAsync();

    const seq = productTypes(events);
    expect(seq[0]).toBe('event.session.work_changed');
    expect(seq[seq.length - 1]).toBe('event.session.work_changed');
    expect(seq).toContain('event.message.created');
    expect(seq).toContain('event.assistant.delta');
    expect(seq).toContain('event.message.updated');
    expect(seq).toContain('event.tool.output');

    // Every frame carries the {sessionId,agentId,event} envelope (contract F).
    for (const payload of events) {
      expect(payload.sessionId).toBe(session.id);
      expect(payload.agentId).toBe('main');
      expect(payload.event.session_id).toBe(session.id);
      expect(typeof payload.event.seq).toBe('number');
    }
  });

  // Slice 3 event convergence: the mock stream mirrors the sidecar hub — per-
  // session monotonic seq, a bounded journal, a subscription gate, and cursor
  // replay / resync on resubscribe.

  it('gates delivery on subscription and replays journaled frames on resume', async () => {
    const bridge = new MockDesktopBridge();
    const events: ProductEventPayload[] = [];
    bridge.onProductEvent((payload) => events.push(payload));
    const session = await call<WireSession>(bridge, 'createSession', [{}]);

    // First turn while subscribed: frames are delivered and journaled.
    await bridge.ProductSubscribe(session.id, 'main');
    await call(bridge, 'submitPrompt', [session.id, { content: [{ type: 'text', text: 'one' }] }]);
    await vi.runAllTimersAsync();
    const deliveredSeqs = events.map((e) => e.event.seq);
    const lastSeq = Math.max(...deliveredSeqs);
    expect(lastSeq).toBeGreaterThan(0);

    // Detach, then run another turn while detached: journaled, NOT delivered.
    await bridge.ProductUnsubscribe(session.id, 'main');
    await call(bridge, 'submitPrompt', [session.id, { content: [{ type: 'text', text: 'two' }] }]);
    await vi.runAllTimersAsync();
    expect(events.map((e) => e.event.seq)).toEqual(deliveredSeqs);

    // Resubscribe from the last delivered seq: the journal replays exactly the
    // missed frames (all seq > lastSeq), no earlier frame repeated.
    await bridge.ProductSubscribe(session.id, 'main', { epoch: 'mock-epoch', afterSeq: lastSeq });
    const replayed = events.slice(deliveredSeqs.length);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((e) => e.event.seq > lastSeq)).toBe(true);
    const allSeqs = events.map((e) => e.event.seq);
    expect(new Set(allSeqs).size).toBe(allSeqs.length);
    expect(allSeqs).toEqual([...allSeqs].sort((a, b) => a - b));
  });

  it('pushes a resync_required frame when the cursor epoch no longer matches', async () => {
    const bridge = new MockDesktopBridge();
    const events: ProductEventPayload[] = [];
    bridge.onProductEvent((payload) => events.push(payload));
    const session = await call<WireSession>(bridge, 'createSession', [{}]);

    // A cursor from a different epoch cannot be covered incrementally.
    await bridge.ProductSubscribe(session.id, 'main', { epoch: 'stale-epoch', afterSeq: 1 });

    const frame = events.at(-1)?.event as unknown as {
      type: string;
      payload: { reason: string; session_id: string; epoch?: string };
    };
    expect(frame.type).toBe('resync_required');
    expect(frame.payload.reason).toBe('epoch_changed');
    expect(frame.payload.session_id).toBe(session.id);
    expect(frame.payload.epoch).toBe('mock-epoch');
  });

  it('abortPrompt reports aborted and flips the session idle', async () => {
    const bridge = new MockDesktopBridge();
    const events: ProductEventPayload[] = [];
    bridge.onProductEvent((payload) => events.push(payload));
    const session = await call<WireSession>(bridge, 'createSession', [{}]);
    // Product frames are delivered only while subscribed (unsubscribe stops them).
    await bridge.ProductSubscribe(session.id, 'main');

    const result = await call<{ aborted: boolean }>(bridge, 'abortPrompt', [session.id, 'pr-1']);
    expect(result.aborted).toBe(true);
    const last = events[events.length - 1]?.event as { type: string; payload: { last_turn_reason?: string } };
    expect(last.type).toBe('event.session.work_changed');
    expect(last.payload.last_turn_reason).toBe('cancelled');
  });

  it('respondApproval / respondQuestion resolve and emit the resolved event', async () => {
    const bridge = new MockDesktopBridge();
    const events: ProductEventPayload[] = [];
    bridge.onProductEvent((payload) => events.push(payload));
    const session = await call<WireSession>(bridge, 'createSession', [{}]);
    await bridge.ProductSubscribe(session.id, 'main');

    const approval = await call<{ resolved: true; resolved_at: string }>(
      bridge,
      'respondApproval',
      [session.id, 'ap-1', { decision: 'approved' }],
    );
    expect(approval.resolved).toBe(true);
    expect(events[events.length - 1]?.event.type).toBe('event.approval.resolved');

    const question = await call<{ resolved: true; resolved_at: string }>(
      bridge,
      'respondQuestion',
      [session.id, 'q-1', { answers: {} }],
    );
    expect(question.resolved).toBe(true);
    expect(events[events.length - 1]?.event.type).toBe('event.question.answered');
  });

  it('unknown product methods throw a clear error', async () => {
    const bridge = new MockDesktopBridge();
    const pending = bridge.ProductCall('unsupportedProductMethod', '[]');
    // Attach the rejection handler before advancing timers so the rejected
    // promise never sits unhandled (the mock throws after its async delay).
    const assertion = expect(pending).rejects.toThrow(/not yet supported/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('updateSession persists model + thinking and getSessionStatus echoes them', async () => {
    const bridge = new MockDesktopBridge();
    const session = await call<WireSession>(bridge, 'createSession', [{}]);
    expect(session.agent_config.model).toBe('mock-model');

    const updated = await call<WireSession>(bridge, 'updateSession', [
      session.id,
      { agent_config: { model: 'mock-model-mini', thinking: 'high' } },
    ]);
    expect(updated.agent_config.model).toBe('mock-model-mini');
    expect(updated.agent_config.thinking).toBe('high');

    const status = await call<{
      model: string;
      thinking_level: string;
      plan_mode: boolean;
      swarm_mode: boolean;
    }>(bridge, 'getSessionStatus', [session.id]);
    expect(status.model).toBe('mock-model-mini');
    expect(status.thinking_level).toBe('high');
  });

  // Slice 2 clean-boot methods (docs §12.3): the mock returns canned kap-server
  // wire shapes wrapped in a code:0 WireEnvelope, so ?desktop_transport=1 boots
  // in a plain browser without the Go side.
  it('serves the 8 boot methods as code:0 envelopes with kap-server wire shapes', async () => {
    const bridge = new MockDesktopBridge();
    const session = await call<WireSession>(bridge, 'createSession', [{ metadata: { cwd: '/mock' } }]);

    const auth = await call<{ ready: boolean; providers_count: number; default_model: string | null; managed_provider: { status: string } | null }>(bridge, 'getAuth', []);
    expect(auth.ready).toBe(true);
    expect(auth.providers_count).toBe(1);
    expect(auth.managed_provider).toEqual({ status: 'connected' });

    const health = await call<{ ok: true }>(bridge, 'getHealth', []);
    expect(health.ok).toBe(true);

    const meta = await call<{ server_version: string; server_id: string; backend: string; capabilities: Record<string, boolean> }>(bridge, 'getMeta', []);
    expect(meta.backend).toBe('v2');
    expect(meta.server_id).toBe('mock-server');

    const config = await call<{ providers: Record<string, unknown>; default_model?: string }>(bridge, 'getConfig', []);
    expect(config.default_model).toBe('mock-model');
    expect(config.providers['mock']).toBeTruthy();

    const workspaces = await call<{ items: Array<{ id: string; root: string }>; has_more: boolean }>(bridge, 'listWorkspaces', []);
    expect(workspaces.has_more).toBe(false);
    expect(workspaces.items.map((w) => w.id)).toContain('mock-workspace');

    const fsHome = await call<{ home: string; recent_roots: string[] }>(bridge, 'getFsHome', []);
    expect(fsHome.home).toBe('/mock');

    const models = await call<{ items: Array<{ provider: string; model: string; max_context_size: number }> }>(bridge, 'listModels', []);
    expect(models.items.map((m) => m.model)).toContain('mock-model');

    const snapshot = await call<{ as_of_seq: number; epoch: string; session: WireSession; messages: { items: unknown[]; has_more: boolean }; in_flight_turn: unknown; pending_approvals: unknown[]; pending_questions: unknown[] }>(
      bridge,
      'getSessionSnapshot',
      [session.id],
    );
    expect(snapshot.session.id).toBe(session.id);
    expect(snapshot.epoch).toBe('mock-epoch');
    expect(snapshot.in_flight_turn).toBeNull();
    expect(snapshot.messages.items).toHaveLength(0);
    expect(snapshot.pending_approvals).toHaveLength(0);
    expect(snapshot.pending_questions).toHaveLength(0);
  });
});
