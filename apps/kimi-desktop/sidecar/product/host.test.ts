/**
 * Real IPC integration tests for the product host — the full wire protocol
 * over an actual Unix socket (hello auth, call success / structured error,
 * product listen with journal replay + resync_required, stream data/end/error
 * and cancellation), with a fake facade + projector so no engine is needed.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
import { RPCError } from '@moonshot-ai/klient';

import { serveProductIpc } from './host.js';
import { ProductStreamHub } from './stream.js';
import type { ProductFacade } from './facade.js';
import type { ProductProjector } from './projector.js';
import type { WireEvent } from './wire.js';

interface Frame {
  type: string;
  id?: string;
  data?: unknown;
  code?: number;
  msg?: string;
}

const TERMINAL_TYPES = new Set(['result', 'error', 'listen_result', 'stream_end', 'stream_error']);

/** Minimal NDJSON IPC client speaking the klient-ipc frame protocol. */
class TestIpcClient {
  private socket: ReturnType<typeof connect> | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, (frame: Frame) => void>();
  private readonly queued: Frame[] = [];
  private waiters: Array<(frame: Frame) => void> = [];

  async connect(socketPath: string): Promise<void> {
    this.socket = connect(socketPath);
    this.socket.setEncoding('utf8');
    this.rl = createInterface({ input: this.socket, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        return;
      }
      if (frame.id !== undefined && TERMINAL_TYPES.has(frame.type)) {
        const waiter = this.pending.get(frame.id);
        if (waiter !== undefined) {
          this.pending.delete(frame.id);
          waiter(frame);
          return;
        }
      }
      // Events and stream data frames are consumed in arrival order.
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else this.queued.push(frame);
    });
    await once(this.socket, 'connect');
    // The host greets every connection with a `ready` frame — consume it so
    // test assertions never see it.
    const first = await this.nextFrame(3000);
    if (first.type !== 'ready') {
      throw new Error(`expected the host's ready frame, got ${first.type}`);
    }
  }

  send(frame: Record<string, unknown>): void {
    this.socket?.write(`${JSON.stringify(frame)}\n`);
  }

  hello(token: string): void {
    this.send({ type: 'hello', token });
  }

  private request(prefix: string, frame: Record<string, unknown>): Promise<Frame> {
    const id = `${prefix}${++this.nextId}`;
    const promise = new Promise<Frame>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.send({ ...frame, id });
    return promise;
  }

  call(service: string, method: string, arg: unknown[], scope = 'core'): Promise<Frame> {
    return this.request('c', { type: 'call', scope, service, method, arg });
  }

  listen(service: string, event: string, scope: Record<string, string>, arg?: unknown[]): Promise<Frame> {
    return this.request('l', { type: 'listen', scope: 'session', service, event, arg, ...scope });
  }

  unlisten(id: string): void {
    this.send({ type: 'unlisten', id });
  }

  stream(service: string, method: string, arg: unknown[]): Promise<Frame> {
    return this.request('s', { type: 'stream', scope: 'core', service, method, arg });
  }

  /** Fire-and-forget stream start (used with streamCancel). */
  streamId(): string {
    return `s${++this.nextId}`;
  }

  sendStream(id: string, service: string, method: string, arg: unknown[]): void {
    this.send({ type: 'stream', id, scope: 'core', service, method, arg });
  }

  streamCancel(id: string): void {
    this.send({ type: 'stream_cancel', id });
  }

  nextFrame(timeoutMs = 3000): Promise<Frame> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}

function wireEvent(seq: number): WireEvent {
  return {
    type: 'event.message.updated',
    seq,
    session_id: 's-1',
    timestamp: new Date().toISOString(),
    payload: { message_id: `m${seq}`, content: [], status: 'completed' },
  } as unknown as WireEvent;
}

interface HostFixture {
  host: Awaited<ReturnType<typeof serveProductIpc>>;
  socketPath: string;
  pushes: Array<(event: WireEvent) => void>;
  hub: ProductStreamHub;
  clean: () => Promise<void>;
}

async function startHost(overrides: {
  facade?: Partial<
    Pick<
      ProductFacade,
      'dispatch' | 'streamDispatch' | 'terminalListen' | 'cancelUploadsForConnection'
    >
  >;
  token?: string;
  hubCapacity?: number;
}): Promise<HostFixture> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-host-'));
  const socketPath = join(root, 'ipc.sock');
  const scope = { accessor: { get: () => undefined } };
  const pushes: Array<(event: WireEvent) => void> = [];
  const projector = {
    subscribe: (_s: string, _a: string, push: (e: WireEvent) => void) => {
      pushes.push(push);
      return { dispose: () => undefined };
    },
  };
  const hub = new ProductStreamHub(projector as unknown as ProductProjector, overrides.hubCapacity);
  const host = await serveProductIpc({
    scope: scope as never,
    endpoint: socketPath,
    token: overrides.token ?? 'test-token',
    overrides: {
      facade: {
        dispatch: async () => ({ code: 0, msg: 'success', data: { ok: true }, request_id: 'r' }),
        streamDispatch: async function* () {
          yield { chunk: 'aGVsbG8=', seq: 1 };
          yield { end: true, mime: 'text/plain', size: 5, filename: 'x.txt' };
        },
        terminalListen: async () => ({ dispose: () => undefined }),
        cancelUploadsForConnection: async () => undefined,
        ...overrides.facade,
      } as unknown as ProductFacade,
      hub,
    },
  });
  return { host, socketPath, pushes, hub, clean: async () => rm(root, { recursive: true, force: true }) };
}

async function withClient<T>(
  fixture: HostFixture,
  run: (client: TestIpcClient) => Promise<T>,
): Promise<T> {
  const client = new TestIpcClient();
  await client.connect(fixture.socketPath);
  try {
    client.hello('test-token');
    return await run(client);
  } finally {
    client.close();
    await fixture.host.close();
    await fixture.clean();
  }
}

describe('serveProductIpc over a real socket', () => {
  it('rejects a wrong hello token and closes the connection', async () => {
    const fixture = await startHost({});
    const client = new TestIpcClient();
    await client.connect(fixture.socketPath);
    client.hello('wrong-token');
    const frame = await client.nextFrame(3000);
    expect(frame.type).toBe('error');
    expect(frame.code).toBe(40100);
    client.close();
    await fixture.host.close();
    await fixture.clean();
  });

  it('serves a successful product call', async () => {
    const fixture = await startHost({});
    await withClient(fixture, async (client) => {
      const result = await client.call('desktopProduct', 'getHealth', []);
      expect(result.type).toBe('result');
      // The facade answers with the WireEnvelope, forwarded verbatim.
      expect((result.data as { data: { ok: boolean } }).data.ok).toBe(true);
    });
  });

  it('reports a structured RPC error (code + msg) for a failing call', async () => {
    const fixture = await startHost({
      facade: {
        dispatch: async () => {
          throw new RPCError(40407, 'file f_missing does not exist');
        },
      },
    });
    await withClient(fixture, async (client) => {
      const result = await client.call('desktopProduct', 'getFileBlob', ['f_missing']);
      expect(result.type).toBe('error');
      expect(result.code).toBe(40407);
      expect(result.msg).toContain('f_missing');
    });
  });

  it('subscribes to the product stream and delivers live events with stamped seq', async () => {
    const fixture = await startHost({});
    await withClient(fixture, async (client) => {
      const ack = await client.listen('desktopProduct', 'product', { sessionId: 's-1' });
      expect(ack.type).toBe('listen_result');
      fixture.pushes[0]!(wireEvent(0));
      const frame = await client.nextFrame();
      expect(frame.type).toBe('event');
      const data = frame.data as WireEvent;
      expect(data.type).toBe('event.message.updated');
      expect(data.seq).toBe(1);
      expect(data.session_id).toBe('s-1');
    });
  });

  it('replays journaled frames for a resume cursor, then goes live', async () => {
    const fixture = await startHost({});
    await withClient(fixture, async (client) => {
      await client.listen('desktopProduct', 'product', { sessionId: 's-1' });
      fixture.pushes[0]!(wireEvent(0));
      fixture.pushes[0]!(wireEvent(0));
      await client.nextFrame();
      await client.nextFrame();

      const { epoch } = fixture.hub.watermark('s-1', 'main');
      const ack = await client.listen('desktopProduct', 'product', { sessionId: 's-1' }, [
        { epoch, after_seq: 1 },
      ]);
      expect(ack.type).toBe('listen_result');
      const replayed = (await client.nextFrame()).data as WireEvent;
      expect(replayed.type).toBe('event.message.updated');
      expect(replayed.seq).toBe(2);
      // Live delivery continues after the replay.
      fixture.pushes[0]!(wireEvent(0));
      expect(((await client.nextFrame()).data as WireEvent).seq).toBe(3);
    });
  });

  it('sends resync_required when the journal cannot cover the cursor', async () => {
    // Small journal capacity so the gap materializes quickly.
    const fixture = await startHost({ hubCapacity: 2 });
    await withClient(fixture, async (client) => {
      await client.listen('desktopProduct', 'product', { sessionId: 's-1' });
      fixture.pushes[0]!(wireEvent(0));
      fixture.pushes[0]!(wireEvent(0));
      fixture.pushes[0]!(wireEvent(0));
      await client.nextFrame();
      await client.nextFrame();
      await client.nextFrame();
      const { epoch } = fixture.hub.watermark('s-1', 'main');
      // Cursor 0 while the journal only retains seq 2..3 → buffer overflow.
      const ack = await client.listen('desktopProduct', 'product', { sessionId: 's-1' }, [
        { epoch, after_seq: 0 },
      ]);
      expect(ack.type).toBe('listen_result');
      const frame = await client.nextFrame();
      const payload = (frame.data as { payload?: { reason?: string; current_seq?: number } }).payload;
      expect(payload?.reason).toBe('buffer_overflow');
      expect(payload?.current_seq).toBe(3);
    });
  });

  it('streams data + end meta', async () => {
    const fixture = await startHost({});
    await withClient(fixture, async (client) => {
      const ack = await client.stream('desktopProduct', 'getFileBlob', ['f_1']);
      expect(ack.type).toBe('stream_end');
      expect((ack.data as { mime: string }).mime).toBe('text/plain');
    });
  });

  it('streams a data chunk before the end and honors stream_cancel', async () => {
    const abortedRef: string[] = [];
    const fixture = await startHost({
      facade: {
        streamDispatch: async function* (
          _m: string,
          _a: unknown[],
          _c: unknown,
          signal?: AbortSignal,
        ) {
          yield { chunk: 'Y2hvbmc=', seq: 1 };
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (signal?.aborted) {
            abortedRef.push('aborted');
            return;
          }
          yield { chunk: 'eA==', seq: 2 };
        },
      },
    });
    await withClient(fixture, async (client) => {
      const id = client.streamId();
      client.sendStream(id, 'desktopProduct', 'getFileBlob', ['f_1']);
      const data = await client.nextFrame();
      expect(data.type).toBe('stream_data');
      expect((data.data as { chunk: string }).chunk).toBe('Y2hvbmc=');
      client.streamCancel(id);
      // The generator resumes shortly after and observes the abort signal.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(abortedRef).toEqual(['aborted']);
    });
  });

  it('reports stream errors with the structured code', async () => {
    const fixture = await startHost({
      facade: {
        streamDispatch: async function* () {
          throw new RPCError(40407, 'file f_missing does not exist');
        },
      },
    });
    await withClient(fixture, async (client) => {
      const ack = await client.stream('desktopProduct', 'getFileBlob', ['f_missing']);
      expect(ack.type).toBe('stream_error');
      expect(ack.code).toBe(40407);
      expect(ack.msg).toContain('f_missing');
    });
  });
});
