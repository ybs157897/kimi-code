/**
 * ProductStreamHub tests — cursor catch-up, journal replay, suspend semantics
 * (IPC-disconnect journal continuity) and resync_required, with a fake
 * projector so no engine is needed.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ProductProjector } from './projector.js';
import { ProductStreamHub } from './stream.js';
import type { ProductFrame, WireEvent, WireResyncRequired } from './wire.js';

interface FakeProjectorLike {
  subscribe: ReturnType<typeof vi.fn>;
  disposals: number;
}

function makeHub(): {
  hub: ProductStreamHub;
  projector: FakeProjectorLike;
  registrations: Array<{ sessionId: string; agentId: string; push: (event: WireEvent) => void }>;
} {
  const registrations: Array<{
    sessionId: string;
    agentId: string;
    push: (event: WireEvent) => void;
  }> = [];
  const projector = {
    disposals: 0,
    subscribe: vi.fn((sessionId: string, agentId: string, push: (event: WireEvent) => void) => {
      registrations.push({ sessionId, agentId, push });
      return {
        dispose: () => {
          projector.disposals += 1;
        },
      };
    }),
  };
  const hub = new ProductStreamHub(projector as unknown as ProductProjector);
  return { hub, projector, registrations };
}

function frame(seq: number): WireEvent {
  return {
    type: 'event.message.updated',
    seq,
    session_id: 's-1',
    timestamp: new Date().toISOString(),
    payload: { message_id: `m${seq}`, content: [], status: 'completed' },
  } as unknown as WireEvent;
}

function isResync(event: WireEvent | WireResyncRequired): event is WireResyncRequired {
  return (event as { type?: string }).type === 'resync_required';
}

describe('ProductStreamHub', () => {
  it('stamps seq, journals, and fans out to live listeners', () => {
    const { hub, registrations } = makeHub();
    const received: WireEvent[] = [];
    const listen = hub.subscribe('s-1', 'main', undefined, (frame: ProductFrame) => { received.push(frame as WireEvent); });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ sessionId: 's-1', agentId: 'main' });

    registrations[0]!.push(frame(0));
    registrations[0]!.push(frame(0));
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
    expect(hub.watermark('s-1', 'main')).toEqual({ epoch: expect.any(String), asOfSeq: 2 });
    listen.dispose();
  });

  it('replays journaled frames after a resume cursor', () => {
    const { hub, registrations } = makeHub();
    const received: WireEvent[] = [];
    hub.subscribe('s-1', 'main', undefined, () => undefined);
    const push = registrations[0]!.push;
    push(frame(0));
    push(frame(0));
    push(frame(0));

    const replayed: WireEvent[] = [];
    const { epoch } = hub.watermark('s-1', 'main');
    const listen = hub.subscribe('s-1', 'main', { epoch, afterSeq: 1 }, (frame: ProductFrame) => {
      replayed.push(frame as WireEvent);
    });
    expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
    // Live delivery continues after the replay, no duplicates.
    push(frame(0));
    expect(replayed.map((e) => e.seq)).toEqual([2, 3, 4]);
    listen.dispose();
  });

  it('suspend keeps the underlying projector + journal alive through the disconnect window', () => {
    const { hub, registrations, projector } = makeHub();
    const first: WireEvent[] = [];
    const listen = hub.subscribe('s-1', 'main', undefined, (frame: ProductFrame) => { first.push(frame as WireEvent); });
    const push = registrations[0]!.push;
    push(frame(0));
    expect(first.map((e) => e.seq)).toEqual([1]);

    // Disconnect: the connection's listen is suspended, not disposed.
    listen.suspend();
    expect(projector.disposals).toBe(0);

    // Events during the disconnected window keep flowing into the journal.
    push(frame(0));
    push(frame(0));

    // Reconnect with the pre-disconnect cursor: the gap is replayed in full.
    const { epoch } = hub.watermark('s-1', 'main');
    const replayed: WireEvent[] = [];
    const second = hub.subscribe('s-1', 'main', { epoch, afterSeq: 1 }, (frame: ProductFrame) => {
      replayed.push(frame as WireEvent);
    });
    expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
    second.dispose();
  });

  it('explicit dispose releases the underlying projector immediately but keeps the journal', () => {
    const { hub, registrations, projector } = makeHub();
    hub.subscribe('s-1', 'main', undefined, () => undefined).dispose();
    expect(projector.disposals).toBe(1);

    // Journal entries survive the dispose; a fresh subscribe replays them.
    registrations[0]!.push(frame(0));
    const replayed: WireEvent[] = [];
    const { epoch } = hub.watermark('s-1', 'main');
    hub.subscribe('s-1', 'main', { epoch, afterSeq: 0 }, (frame: ProductFrame) => { replayed.push(frame as WireEvent); });
    expect(replayed.map((e) => e.seq)).toEqual([1]);
  });

  it('sends resync_required when the journal can no longer cover the cursor', () => {
    const registrations: Array<{
      sessionId: string;
      agentId: string;
      push: (event: WireEvent) => void;
    }> = [];
    const projector = {
      disposals: 0,
      subscribe: vi.fn((sessionId: string, agentId: string, push: (event: WireEvent) => void) => {
        registrations.push({ sessionId, agentId, push });
        return { dispose: () => undefined };
      }),
    };
    // Capacity 2: after three frames the journal only retains seq 2..3.
    const hub = new ProductStreamHub(projector as unknown as ProductProjector, 2);
    hub.subscribe('s-1', 'main', undefined, () => undefined);
    const push = registrations[0]!.push;
    push(frame(0));
    push(frame(0));
    push(frame(0));
    const { epoch } = hub.watermark('s-1', 'main');
    // Cursor 0 with the journal starting at 2 → the gap cannot be bridged.
    const received: Array<WireEvent | WireResyncRequired> = [];
    hub.subscribe('s-1', 'main', { epoch, afterSeq: 0 }, (frame: ProductFrame) => { received.push(frame as WireEvent); });
    expect(received).toHaveLength(1);
    expect(isResync(received[0]!)).toBe(true);
    expect((received[0] as WireResyncRequired).payload.reason).toBe('buffer_overflow');
  });

  it('sends resync_required on an epoch mismatch', () => {
    const { hub } = makeHub();
    const received: Array<WireEvent | WireResyncRequired> = [];
    hub.subscribe('s-1', 'main', { epoch: 'ep_stale', afterSeq: 3 }, (event) =>
      received.push(event),
    );
    expect(received).toHaveLength(1);
    expect(isResync(received[0]!)).toBe(true);
    expect((received[0] as WireResyncRequired).payload.reason).toBe('epoch_changed');
  });

  it('treats an absent cursor as a fresh live subscription', () => {
    const { hub, registrations } = makeHub();
    const received: WireEvent[] = [];
    hub.subscribe('s-1', 'main', undefined, (frame: ProductFrame) => { received.push(frame as WireEvent); });
    expect(received).toHaveLength(0);
    registrations[0]!.push(frame(0));
    expect(received.map((e) => e.seq)).toEqual([1]);
  });
});
