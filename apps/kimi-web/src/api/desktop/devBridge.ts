import { assembleStreamToBlob } from './bridge';
import type {
  DesktopBridge,
  DesktopEventPayload,
  DesktopHelloInfo,
  DesktopSessionHandle,
  DesktopSessionListPage,
  DesktopStreamEvent,
  DesktopStreamResult,
  DesktopTerminalEvent,
  ProductEventPayload,
  ProductStreamCursor,
} from './types';

type ConnectionState = 'connected' | 'disconnected';
type Listener<T> = (value: T) => void;

interface RpcResponse<T> {
  data?: T;
  error?: string;
}

interface WireEnvelope<T> {
  data: T;
}

function clientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `desktop-${Date.now()}-${Math.random()}`;
}

/** Browser implementation of the Wails bridge backed by Vite's dev middleware. */
export class DevDesktopBridge implements DesktopBridge {
  readonly kind = 'dev' as const;

  private readonly id = clientId();
  private events: EventSource | undefined;
  private readonly eventListeners = new Set<Listener<DesktopEventPayload>>();
  private readonly productListeners = new Set<Listener<ProductEventPayload>>();
  private readonly streamListeners = new Set<Listener<DesktopStreamEvent>>();
  private readonly terminalListeners = new Set<Listener<DesktopTerminalEvent>>();
  private readonly connectionListeners = new Set<Listener<ConnectionState>>();

  async Hello(): Promise<DesktopHelloInfo> {
    const platform = await this.rpc<unknown>({
      op: 'coreCall',
      scope: 'core',
      service: 'bootstrapService',
      method: 'platform',
      args: [],
    });
    return { sidecar: 'ok', ipc: 'connected', platform };
  }

  async ListSessions(): Promise<DesktopSessionListPage> {
    return this.rpc<DesktopSessionListPage>({
      op: 'coreCall',
      scope: 'core',
      service: 'sessionIndex',
      method: 'list',
      args: [{}],
    });
  }

  async CreateSession(): Promise<DesktopSessionHandle> {
    const raw = await this.ProductCall('createSession', JSON.stringify([{}]));
    const session = this.unwrap<{ id: string }>('CreateSession', raw);
    return { sessionId: session.id, agentId: 'main' };
  }

  async Submit(sessionId: string, agentId: string, text: string): Promise<void> {
    await this.ProductCall(
      'submitPrompt',
      JSON.stringify([
        sessionId,
        { content: [{ type: 'text', text }], agent_id: agentId },
      ]),
    );
  }

  async Cancel(sessionId: string): Promise<void> {
    await this.ProductCall('abortSession', JSON.stringify([sessionId]));
  }

  onEvent(callback: Listener<DesktopEventPayload>): () => void {
    this.eventListeners.add(callback);
    this.ensureEvents();
    return () => this.eventListeners.delete(callback);
  }

  ProductCall(method: string, argsJSON: string): Promise<string> {
    return this.rpc<string>({ op: 'productCall', method, argsJSON });
  }

  async ProductSubscribe(
    sessionId: string,
    agentId: string,
    cursor?: ProductStreamCursor,
  ): Promise<void> {
    await this.ensureEventsReady();
    await this.rpc({ op: 'productSubscribe', sessionId, agentId, cursor: this.serializeCursor(cursor) });
  }

  ProductUnsubscribe(sessionId: string, agentId: string): Promise<void> {
    return this.rpc({ op: 'productUnsubscribe', sessionId, agentId });
  }

  onProductEvent(callback: Listener<ProductEventPayload>): () => void {
    this.productListeners.add(callback);
    this.ensureEvents();
    return () => this.productListeners.delete(callback);
  }

  async ProductStreamStart(method: string, argsJSON: string): Promise<string> {
    await this.ensureEventsReady();
    return this.rpc<string>({ op: 'streamStart', method, argsJSON });
  }

  ProductStreamCancel(streamId: string): Promise<void> {
    return this.rpc({ op: 'streamCancel', streamId });
  }

  onStreamEvent(callback: Listener<DesktopStreamEvent>): () => void {
    this.streamListeners.add(callback);
    this.ensureEvents();
    return () => this.streamListeners.delete(callback);
  }

  streamToBlob(method: string, args: unknown[], signal?: AbortSignal): Promise<Blob> {
    return assembleStreamToBlob(this, method, args, signal).then(({ blob }) => blob);
  }

  streamToBlobWithMeta(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<DesktopStreamResult> {
    return assembleStreamToBlob(this, method, args, signal);
  }

  async ProductTerminalAttach(
    sessionId: string,
    terminalId: string,
    sinceSeq?: number,
  ): Promise<void> {
    await this.ensureEventsReady();
    await this.rpc({ op: 'terminalAttach', sessionId, terminalId, sinceSeq });
  }

  ProductTerminalDetach(sessionId: string, terminalId: string): Promise<void> {
    return this.rpc({ op: 'terminalDetach', sessionId, terminalId });
  }

  onTerminalEvent(callback: Listener<DesktopTerminalEvent>): () => void {
    this.terminalListeners.add(callback);
    this.ensureEvents();
    return () => this.terminalListeners.delete(callback);
  }

  onConnectionState(callback: Listener<ConnectionState>): () => void {
    this.connectionListeners.add(callback);
    this.ensureEvents();
    return () => this.connectionListeners.delete(callback);
  }

  EnsureConnected(): Promise<ConnectionState> {
    return this.rpc<ConnectionState>({ op: 'ensureConnected' });
  }

  private rpc<T = void>(body: Record<string, unknown>): Promise<T> {
    return fetch('/__kimi-dev/desktop/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, clientId: this.id }),
    }).then(async (response) => {
      const payload = (await response.json()) as RpcResponse<T>;
      if (!response.ok || payload.error !== undefined) {
        throw new Error(payload.error ?? `Desktop dev bridge failed (${response.status})`);
      }
      return payload.data as T;
    });
  }

  private ensureEvents(): void {
    if (this.events !== undefined) return;
    const events = new EventSource(
      `/__kimi-dev/desktop/events?client_id=${encodeURIComponent(this.id)}`,
    );
    events.addEventListener('product', (event) => {
      const payload = this.eventData<ProductEventPayload>(event);
      if (payload === undefined) return;
      for (const listener of this.productListeners) listener(payload);
    });
    events.addEventListener('stream', (event) => {
      const payload = this.eventData<DesktopStreamEvent>(event);
      if (payload === undefined) return;
      for (const listener of this.streamListeners) listener(payload);
    });
    events.addEventListener('terminal', (event) => {
      const payload = this.eventData<DesktopTerminalEvent>(event);
      if (payload === undefined) return;
      for (const listener of this.terminalListeners) listener(payload);
    });
    events.addEventListener('connection', (event) => {
      const state = this.eventData<ConnectionState>(event);
      if (state !== 'connected' && state !== 'disconnected') return;
      for (const listener of this.connectionListeners) listener(state);
    });
    this.events = events;
  }

  private ensureEventsReady(): Promise<void> {
    this.ensureEvents();
    if (this.events?.readyState === EventSource.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const events = this.events;
      if (events === undefined) {
        reject(new Error('Desktop event channel is unavailable'));
        return;
      }
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Desktop event channel timed out'));
      }, 45_000);
      const cleanup = (): void => {
        window.clearTimeout(timer);
        events.removeEventListener('open', onOpen);
        events.removeEventListener('error', onError);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('Desktop event channel failed to connect'));
      };
      events.addEventListener('open', onOpen);
      events.addEventListener('error', onError);
    });
  }

  private eventData<T>(event: Event): T | undefined {
    try {
      return JSON.parse((event as MessageEvent<string>).data) as T;
    } catch {
      return undefined;
    }
  }

  private serializeCursor(cursor?: ProductStreamCursor): Record<string, unknown> | undefined {
    if (cursor === undefined) return undefined;
    return { epoch: cursor.epoch, after_seq: cursor.afterSeq };
  }

  private unwrap<T>(method: string, raw: string): T {
    try {
      return (JSON.parse(raw) as WireEnvelope<T>).data;
    } catch (error) {
      throw new Error(`Desktop dev bridge: ${method} returned invalid JSON: ${String(error)}`);
    }
  }
}
