import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Plugin } from 'vite';

type JsonRecord = Record<string, unknown>;

interface IpcFrame extends JsonRecord {
  type: string;
  id?: string;
  data?: unknown;
  code?: number;
  msg?: string;
}

interface PendingRequest {
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  clientId: string;
  kind: 'product' | 'terminal';
  sessionId: string;
  agentId?: string;
  terminalId?: string;
}

interface RpcRequest extends JsonRecord {
  clientId?: string;
  op?: string;
}

const PRODUCT_SERVICE = 'desktopProduct';
const START_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(value: unknown): unknown[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function readBody(req: IncomingMessage): Promise<RpcRequest> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('desktop dev request is too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}') as RpcRequest);
      } catch (error) {
        reject(new Error(`invalid desktop dev request: ${errorMessage(error)}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Development-only owner of the real Desktop sidecar. It exposes the same
 * bridge contract Wails normally provides through a tiny Vite middleware +
 * SSE seam, so the ordinary browser can debug the `.kimi-desktop` product
 * without building the native shell after every frontend change.
 */
class DesktopDevHost {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private socket: Socket | undefined;
  private starting: Promise<void> | undefined;
  private endpoint = '';
  private readonly token = randomBytes(24).toString('hex');
  private nextId = 0;
  private buffer = '';
  private connected = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionKeys = new Map<string, string>();
  private readonly streamOwners = new Map<string, string>();
  private readonly eventClients = new Map<string, ServerResponse>();

  constructor(private readonly repoRoot: string) {}

  status(): JsonRecord {
    return {
      state: this.connected ? 'connected' : this.starting ? 'starting' : 'stopped',
      endpoint: this.endpoint,
      home: process.env.KIMI_DESKTOP_HOME || `${homedir()}/.kimi-desktop`,
      projectConfigDirName: '.kimi-desktop',
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    this.starting ??= this.start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  attachEvents(clientId: string, res: ServerResponse): void {
    this.eventClients.get(clientId)?.end();
    this.eventClients.set(clientId, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');
    this.emitTo(clientId, 'connection', this.connected ? 'connected' : 'disconnected');
  }

  detachEvents(clientId: string, res: ServerResponse): void {
    if (this.eventClients.get(clientId) !== res) return;
    this.eventClients.delete(clientId);
    for (const [id, sub] of this.subscriptions) {
      if (sub.clientId === clientId) this.unlisten(id);
    }
  }

  async rpc(body: RpcRequest): Promise<unknown> {
    await this.ensureStarted();
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    switch (body.op) {
      case 'productCall':
        return JSON.stringify(
          await this.request({
            type: 'call',
            scope: 'core',
            service: PRODUCT_SERVICE,
            method: String(body.method ?? ''),
            arg: parseArgs(body.argsJSON),
          }),
        );
      case 'coreCall':
        return this.request({
          type: 'call',
          scope: body.scope ?? 'core',
          service: String(body.service ?? ''),
          method: String(body.method ?? ''),
          arg: Array.isArray(body.args) ? body.args : [],
          sessionId: body.sessionId,
          agentId: body.agentId,
        });
      case 'productSubscribe':
        await this.listenProduct(clientId, body);
        return null;
      case 'productUnsubscribe':
        this.unlistenByKey(this.productKey(clientId, body));
        return null;
      case 'streamStart':
        return this.startStream(clientId, body);
      case 'streamCancel':
        this.cancelStream(String(body.streamId ?? ''));
        return null;
      case 'terminalAttach':
        await this.listenTerminal(clientId, body);
        return null;
      case 'terminalDetach':
        this.unlistenByKey(this.terminalKey(clientId, body));
        return null;
      case 'ensureConnected':
        return this.connected ? 'connected' : 'disconnected';
      default:
        throw new Error(`unknown desktop dev operation: ${String(body.op)}`);
    }
  }

  close(): void {
    this.connected = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.child?.kill('SIGTERM');
    this.child = undefined;
    for (const response of this.eventClients.values()) response.end();
    this.eventClients.clear();
    this.rejectPending(new Error('desktop dev host closed'));
  }

  private async start(): Promise<void> {
    const desktopHome = process.env.KIMI_DESKTOP_HOME || `${homedir()}/.kimi-desktop`;
    const child = spawn('pnpm', ['--filter', '@moonshot-ai/kimi-desktop', 'run', 'sidecar'], {
      cwd: this.repoRoot,
      env: {
        ...process.env,
        KIMI_DESKTOP_HOME: desktopHome,
        KIMI_DESKTOP_IPC_ENDPOINT: 'tcp://127.0.0.1:0',
        KIMI_DESKTOP_IPC_TOKEN: this.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[desktop] ${chunk.toString()}`));
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('desktop sidecar startup timed out')), START_TIMEOUT_MS);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const fail = (error: unknown): void => {
        clearTimeout(timer);
        reject(new Error(`desktop sidecar failed to start: ${errorMessage(error)}`));
      };
      child.once('error', fail);
      child.once('exit', (code) => fail(`exited with code ${String(code)}`));
      lines.on('line', (line) => {
        const marker = 'desktop-sidecar ready ';
        const index = line.indexOf(marker);
        if (index < 0) return;
        clearTimeout(timer);
        resolve(line.slice(index + marker.length).trim());
      });
    });
    this.endpoint = endpoint;
    await this.connect(endpoint);
    child.once('exit', () => this.onDisconnected());
  }

  private connect(endpoint: string): Promise<void> {
    const url = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('desktop IPC connection timed out')), 10_000);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.once('connect', () => {
        this.send({ type: 'hello', token: this.token });
        clearTimeout(timer);
        this.connected = true;
        this.broadcast('connection', 'connected');
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('close', () => this.onDisconnected());
    });
  }

  private onDisconnected(): void {
    if (!this.connected && this.socket === undefined) return;
    this.connected = false;
    this.socket = undefined;
    this.subscriptions.clear();
    this.subscriptionKeys.clear();
    this.streamOwners.clear();
    this.rejectPending(new Error('desktop sidecar disconnected'));
    this.broadcast('connection', 'disconnected');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onFrame(JSON.parse(line) as IpcFrame);
      } catch (error) {
        console.warn('[kimi-web] ignored invalid Desktop IPC frame:', errorMessage(error));
      }
    }
  }

  private onFrame(frame: IpcFrame): void {
    const id = frame.id ?? '';
    if (frame.type === 'result' || frame.type === 'listen_result' || frame.type === 'error') {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (frame.type === 'error') {
          pending.reject(new Error(`desktop IPC ${frame.code ?? 0}: ${frame.msg ?? 'unknown error'}`));
        } else {
          pending.resolve(frame.data);
        }
      }
      return;
    }
    if (frame.type === 'event') {
      const sub = this.subscriptions.get(id);
      if (sub === undefined) return;
      if (sub.kind === 'product') {
        this.emitTo(sub.clientId, 'product', {
          sessionId: sub.sessionId,
          agentId: sub.agentId ?? 'main',
          event: frame.data,
        });
      } else {
        this.emitTerminal(sub.clientId, frame.data);
      }
      return;
    }
    if (frame.type.startsWith('stream_')) this.emitStream(id, frame);
  }

  private request(frame: JsonRecord, idPrefix = 'c'): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error('desktop sidecar is not connected'));
    const id = `${idPrefix}${Date.now().toString(36)}_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('desktop IPC request timed out'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...frame, id });
    });
  }

  private send(frame: JsonRecord): void {
    this.socket?.write(`${JSON.stringify(frame)}\n`);
  }

  private async listenProduct(clientId: string, body: RpcRequest): Promise<void> {
    const key = this.productKey(clientId, body);
    if (this.subscriptionKeys.has(key)) return;
    const sessionId = String(body.sessionId ?? '');
    const agentId = String(body.agentId ?? 'main');
    const cursor = body.cursor;
    const id = await this.startListen(
      { type: 'listen', scope: 'agent', event: 'product', sessionId, agentId, arg: cursor ? [cursor] : [] },
      { clientId, kind: 'product', sessionId, agentId },
    );
    this.subscriptionKeys.set(key, id);
  }

  private async listenTerminal(clientId: string, body: RpcRequest): Promise<void> {
    const key = this.terminalKey(clientId, body);
    if (this.subscriptionKeys.has(key)) return;
    const sessionId = String(body.sessionId ?? '');
    const terminalId = String(body.terminalId ?? '');
    const sinceSeq = typeof body.sinceSeq === 'number' ? body.sinceSeq : 0;
    const id = await this.startListen(
      {
        type: 'listen',
        scope: 'session',
        event: 'terminal',
        sessionId,
        arg: [{ terminal_id: terminalId, since_seq: sinceSeq }],
      },
      { clientId, kind: 'terminal', sessionId, terminalId },
    );
    this.subscriptionKeys.set(key, id);
  }

  private async startListen(frame: JsonRecord, subscription: Subscription): Promise<string> {
    const id = `l${Date.now().toString(36)}_${++this.nextId}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('desktop IPC listen timed out'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.subscriptions.set(id, subscription);
    this.send({ ...frame, id });
    try {
      await promise;
      return id;
    } catch (error) {
      this.subscriptions.delete(id);
      throw error;
    }
  }

  private unlistenByKey(key: string): void {
    const id = this.subscriptionKeys.get(key);
    if (id !== undefined) this.unlisten(id);
  }

  private unlisten(id: string): void {
    const sub = this.subscriptions.get(id);
    if (sub === undefined) return;
    this.subscriptions.delete(id);
    this.subscriptionKeys.delete(
      sub.kind === 'product'
        ? `${sub.clientId}:product:${sub.sessionId}:${sub.agentId ?? 'main'}`
        : `${sub.clientId}:terminal:${sub.sessionId}:${sub.terminalId ?? ''}`,
    );
    this.send({ type: 'unlisten', id });
  }

  private startStream(clientId: string, body: RpcRequest): string {
    const id = `s${Date.now().toString(36)}_${++this.nextId}`;
    this.streamOwners.set(id, clientId);
    this.send({
      type: 'stream',
      id,
      scope: 'core',
      service: PRODUCT_SERVICE,
      method: String(body.method ?? ''),
      arg: parseArgs(body.argsJSON),
    });
    return id;
  }

  private cancelStream(id: string): void {
    this.streamOwners.delete(id);
    this.send({ type: 'stream_cancel', id });
  }

  private emitStream(id: string, frame: IpcFrame): void {
    const clientId = this.streamOwners.get(id);
    if (clientId === undefined) return;
    const data = frame.data as JsonRecord | undefined;
    if (frame.type === 'stream_data') {
      this.emitTo(clientId, 'stream', { streamId: id, type: 'data', ...data });
      return;
    }
    this.streamOwners.delete(id);
    if (frame.type === 'stream_end') {
      this.emitTo(clientId, 'stream', { streamId: id, type: 'end', meta: data });
    } else {
      this.emitTo(clientId, 'stream', {
        streamId: id,
        type: 'error',
        code: frame.code,
        msg: frame.msg,
      });
    }
  }

  private emitTerminal(clientId: string, raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return;
    const frame = raw as JsonRecord;
    const payload = frame.payload as JsonRecord | undefined;
    const common = {
      sessionId: String(frame.session_id ?? ''),
      terminalId: String(frame.terminal_id ?? ''),
    };
    if (frame.type === 'terminal_output') {
      this.emitTo(clientId, 'terminal', {
        ...common,
        type: 'output',
        data: String(payload?.data ?? ''),
        seq: Number(frame.seq ?? 0),
      });
    } else if (frame.type === 'terminal_exit') {
      this.emitTo(clientId, 'terminal', {
        ...common,
        type: 'exit',
        exitCode: typeof payload?.exit_code === 'number' ? payload.exit_code : null,
      });
    }
  }

  private productKey(clientId: string, body: RpcRequest): string {
    return `${clientId}:product:${String(body.sessionId ?? '')}:${String(body.agentId ?? 'main')}`;
  }

  private terminalKey(clientId: string, body: RpcRequest): string {
    return `${clientId}:terminal:${String(body.sessionId ?? '')}:${String(body.terminalId ?? '')}`;
  }

  private emitTo(clientId: string, event: string, data: unknown): void {
    const response = this.eventClients.get(clientId);
    response?.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    for (const clientId of this.eventClients.keys()) this.emitTo(clientId, event, data);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function desktopBackendPlugin(repoRoot: string): Plugin {
  const host = new DesktopDevHost(repoRoot);
  return {
    name: 'kimi-desktop-dev-backend',
    configureServer(server) {
      server.httpServer?.once('close', () => host.close());
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/__kimi-dev/desktop/status') {
          sendJson(res, 200, host.status());
          return;
        }
        if (url.pathname === '/__kimi-dev/desktop/events') {
          const clientId = url.searchParams.get('client_id');
          if (!clientId) {
            sendJson(res, 400, { error: 'client_id is required' });
            return;
          }
          void host.ensureStarted().then(
            () => {
              host.attachEvents(clientId, res);
              req.once('close', () => host.detachEvents(clientId, res));
            },
            (error: unknown) => sendJson(res, 503, { error: errorMessage(error) }),
          );
          return;
        }
        if (url.pathname === '/__kimi-dev/desktop/rpc' && req.method === 'POST') {
          void readBody(req).then(
            (body) => host.rpc(body).then((data) => sendJson(res, 200, { data })),
            (error: unknown) => sendJson(res, 400, { error: errorMessage(error) }),
          ).catch((error: unknown) => sendJson(res, 500, { error: errorMessage(error) }));
          return;
        }
        next();
      });
    },
  };
}
