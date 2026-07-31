// apps/kimi-web/src/api/desktop/bridge.ts
// Reasonix-style Wails bridge: lazily resolves `window.go.main.App` per call
// and forwards to the frozen contract C bind methods, parsing the JSON-string
// results; subscribes to the `kimi:event` channel via `window.runtime`.

import { bytesFromBase64 } from './base64';
import type {
  DesktopBridge,
  DesktopConnectionState,
  DesktopEventPayload,
  DesktopHelloInfo,
  DesktopSessionHandle,
  DesktopSessionListPage,
  DesktopStreamEvent,
  DesktopStreamMeta,
  DesktopStreamResult,
  DesktopTerminalEvent,
  ProductEventPayload,
  ProductStreamCursor,
  WailsAppBindings,
} from './types';
import {
  KIMI_CONNECTION_CHANNEL,
  KIMI_EVENT_CHANNEL,
  KIMI_STREAM_CHANNEL,
  KIMI_TERMINAL_CHANNEL,
} from './types';

/**
 * The stream primitives `assembleStreamToBlob` needs — the subset of
 * `DesktopBridge` both the Wails wrapper and the dev mock implement, so the
 * mock exercises the exact same assembly path as the real shell.
 */
export interface DesktopStreamTransport {
  ProductStreamStart(method: string, argsJSON: string): Promise<string>;
  ProductStreamCancel(streamId: string): Promise<void>;
  onStreamEvent(callback: (event: DesktopStreamEvent) => void): () => void;
}

/**
 * Slice 5 download assembly: start a `desktopProduct` stream, collect its
 * base64 chunks in arrival order (the IPC socket and the Wails event bus are
 * both ordered, so `seq` only serves debugging), and resolve a Blob typed with
 * the `end` frame's `meta.mime` (defaulting to `application/octet-stream`)
 * alongside the `end` frame's metadata itself — `streamToBlob` maps that to
 * the blob alone, `streamToBlobWithMeta` hands both to the caller (Slice 7
 * exportSession names the downloaded archive from `meta.filename`).
 * Rejects on an `error` frame; an aborted signal cancels the stream upstream
 * and rejects.
 */
export function assembleStreamToBlob(
  transport: DesktopStreamTransport,
  method: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<DesktopStreamResult> {
  const abortError = (): Error => new Error(`desktop transport: ${method} stream aborted`);
  if (signal?.aborted) return Promise.reject(abortError());
  return transport.ProductStreamStart(method, JSON.stringify(args)).then((streamId) => {
    if (signal?.aborted) {
      void transport.ProductStreamCancel(streamId).catch(() => undefined);
      throw abortError();
    }
    return new Promise<DesktopStreamResult>((resolve, reject) => {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let mime = 'application/octet-stream';
      let meta: DesktopStreamMeta | undefined;
      let settled = false;
      const cleanup = (): void => {
        off();
        signal?.removeEventListener('abort', onAbort);
      };
      const off = transport.onStreamEvent((event) => {
        if (settled || event.streamId !== streamId) return;
        if (event.type === 'data') {
          if (event.chunk !== undefined) chunks.push(bytesFromBase64(event.chunk));
          return;
        }
        settled = true;
        cleanup();
        if (event.type === 'end') {
          if (event.meta?.mime !== undefined && event.meta.mime !== '') mime = event.meta.mime;
          meta = event.meta;
          resolve({ blob: new Blob(chunks, { type: mime }), meta });
        } else {
          reject(
            new Error(
              `desktop transport: ${method} stream failed (${event.code ?? 0}): ${event.msg ?? 'unknown error'}`,
            ),
          );
        }
      });
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void transport.ProductStreamCancel(streamId).catch(() => undefined);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort);
    });
  });
}

/** Parse a bind-method's JSON-string result with a method-tagged error. */
function parseResult<T>(method: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`desktop bridge: ${method} returned invalid JSON: ${String(error)}`);
  }
}

/**
 * Serialize a product resume cursor to the sidecar's snake_case listen-arg JSON
 * (`{epoch?, after_seq?}`). Returns '' when there is nothing to resume from, so
 * the Go shell subscribes live.
 */
function serializeCursor(cursor?: ProductStreamCursor): string {
  if (cursor === undefined) return '';
  const wire: { epoch?: string; after_seq?: number } = {};
  if (cursor.epoch !== undefined) wire.epoch = cursor.epoch;
  if (cursor.afterSeq !== undefined) wire.after_seq = cursor.afterSeq;
  if (wire.epoch === undefined && wire.after_seq === undefined) return '';
  return JSON.stringify(wire);
}

export class WailsDesktopBridge implements DesktopBridge {
  readonly kind = 'wails' as const;

  private listeners = new Set<(payload: DesktopEventPayload) => void>();
  private productListeners = new Set<(payload: ProductEventPayload) => void>();
  private nativeAttached = false;
  // Slice 5 binary streams ride a separate `kimi:stream` channel, so they keep
  // their own listener set and native-attach refcount.
  private streamListeners = new Set<(event: DesktopStreamEvent) => void>();
  private streamNativeAttached = false;
  // Slice 6 terminal output/exit ride their own `kimi:terminal` channel (never
  // mixed into the chat `kimi:event` stream), with the same refcount pattern.
  private terminalListeners = new Set<(event: DesktopTerminalEvent) => void>();
  private terminalNativeAttached = false;
  // Real IPC connection state (`kimi:connection`), with its own refcount.
  private connectionListeners = new Set<(state: 'connected' | 'disconnected') => void>();
  private connectionNativeAttached = false;

  /**
   * Resolve the bound `App` lazily on every call — Wails injects the bindings
   * into the webview, so a module-load-time capture could race the injection.
   */
  private bindings(): WailsAppBindings {
    const app = window.go?.main?.App;
    if (!app) {
      throw new Error('desktop bridge: window.go.main.App is unavailable');
    }
    return app;
  }

  async Hello(): Promise<DesktopHelloInfo> {
    return parseResult<DesktopHelloInfo>('Hello', await this.bindings().Hello());
  }

  async ListSessions(): Promise<DesktopSessionListPage> {
    return parseResult<DesktopSessionListPage>('ListSessions', await this.bindings().ListSessions());
  }

  async CreateSession(): Promise<DesktopSessionHandle> {
    return parseResult<DesktopSessionHandle>('CreateSession', await this.bindings().CreateSession());
  }

  async Submit(sessionId: string, agentId: string, text: string): Promise<void> {
    await this.bindings().Submit(sessionId, agentId, text);
  }

  async Cancel(sessionId: string, agentId: string): Promise<void> {
    await this.bindings().Cancel(sessionId, agentId);
  }

  async ProductCall(method: string, argsJSON: string): Promise<string> {
    // The Go side is a thin passthrough (frozen contract F): it forwards the
    // `desktopProduct` call over IPC and returns the kimi-web response wire JSON
    // verbatim. Parsing into App types is the caller's job (WailsKimiWebApi).
    return this.bindings().ProductCall(method, argsJSON);
  }

  async ProductStreamStart(method: string, argsJSON: string): Promise<string> {
    // Thin passthrough like ProductCall (Slice 5): the Go shell opens the IPC
    // `stream` frame and returns the stream id; frames arrive on `kimi:stream`.
    return this.bindings().ProductStreamStart(method, argsJSON);
  }

  async ProductStreamCancel(streamId: string): Promise<void> {
    await this.bindings().ProductStreamCancel(streamId);
  }

  async ProductSubscribe(
    sessionId: string,
    agentId: string,
    cursor?: ProductStreamCursor,
  ): Promise<void> {
    // Serialize the cursor to the sidecar's snake_case listen arg; an absent or
    // empty cursor becomes '' (a fresh live subscription).
    const cursorJSON = serializeCursor(cursor);
    await this.bindings().ProductSubscribe(sessionId, agentId, cursorJSON);
  }

  async ProductUnsubscribe(sessionId: string, agentId: string): Promise<void> {
    await this.bindings().ProductUnsubscribe(sessionId, agentId);
  }

  async ProductTerminalAttach(
    sessionId: string,
    terminalId: string,
    sinceSeq?: number,
  ): Promise<void> {
    // The Go bind takes the replay cursor as a JSON string; an absent cursor
    // becomes `0`, and the engine's attach contract replays the terminal's
    // whole buffered history (every frame strictly after the cursor).
    await this.bindings().ProductTerminalAttach(sessionId, terminalId, JSON.stringify(sinceSeq ?? 0));
  }

  async ProductTerminalDetach(sessionId: string, terminalId: string): Promise<void> {
    await this.bindings().ProductTerminalDetach(sessionId, terminalId);
  }

  onEvent(callback: (payload: DesktopEventPayload) => void): () => void {
    this.listeners.add(callback);
    this.attachNative();
    return () => {
      this.listeners.delete(callback);
      this.maybeDetachNative();
    };
  }

  onProductEvent(callback: (payload: ProductEventPayload) => void): () => void {
    this.productListeners.add(callback);
    this.attachNative();
    return () => {
      this.productListeners.delete(callback);
      this.maybeDetachNative();
    };
  }

  onStreamEvent(callback: (event: DesktopStreamEvent) => void): () => void {
    this.streamListeners.add(callback);
    this.attachStreamNative();
    return () => {
      this.streamListeners.delete(callback);
      if (this.streamListeners.size === 0) this.detachStreamNative();
    };
  }

  onTerminalEvent(callback: (event: DesktopTerminalEvent) => void): () => void {
    this.terminalListeners.add(callback);
    this.attachTerminalNative();
    return () => {
      this.terminalListeners.delete(callback);
      if (this.terminalListeners.size === 0) this.detachTerminalNative();
    };
  }

  onConnectionState(callback: (state: 'connected' | 'disconnected') => void): () => void {
    this.connectionListeners.add(callback);
    this.attachConnectionNative();
    return () => {
      this.connectionListeners.delete(callback);
      if (this.connectionListeners.size === 0) this.detachConnectionNative();
    };
  }

  async EnsureConnected(): Promise<'connected' | 'disconnected'> {
    const raw = await this.bindings().EnsureConnected();
    try {
      const info = JSON.parse(raw) as Partial<DesktopConnectionState>;
      return info.state === 'connected' ? 'connected' : 'disconnected';
    } catch {
      return 'disconnected';
    }
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

  /**
   * Wails `EventsOff` drops every callback for the channel, so only detach once
   * neither the Phase 0 raw listeners nor the Phase 1 product listeners remain.
   */
  private maybeDetachNative(): void {
    if (this.listeners.size === 0 && this.productListeners.size === 0) this.detachNative();
  }

  private attachNative(): void {
    if (this.nativeAttached) return;
    const runtime = window.runtime;
    if (!runtime) {
      throw new Error('desktop bridge: window.runtime is unavailable');
    }
    runtime.EventsOn(KIMI_EVENT_CHANNEL, this.onNativePayload);
    this.nativeAttached = true;
  }

  private detachNative(): void {
    if (!this.nativeAttached) return;
    window.runtime?.EventsOff(KIMI_EVENT_CHANNEL);
    this.nativeAttached = false;
  }

  private attachStreamNative(): void {
    if (this.streamNativeAttached) return;
    const runtime = window.runtime;
    if (!runtime) {
      throw new Error('desktop bridge: window.runtime is unavailable');
    }
    runtime.EventsOn(KIMI_STREAM_CHANNEL, this.onNativeStreamPayload);
    this.streamNativeAttached = true;
  }

  private detachStreamNative(): void {
    if (!this.streamNativeAttached) return;
    window.runtime?.EventsOff(KIMI_STREAM_CHANNEL);
    this.streamNativeAttached = false;
  }

  private attachTerminalNative(): void {
    if (this.terminalNativeAttached) return;
    const runtime = window.runtime;
    if (!runtime) {
      throw new Error('desktop bridge: window.runtime is unavailable');
    }
    runtime.EventsOn(KIMI_TERMINAL_CHANNEL, this.onNativeTerminalPayload);
    this.terminalNativeAttached = true;
  }

  private detachTerminalNative(): void {
    if (!this.terminalNativeAttached) return;
    window.runtime?.EventsOff(KIMI_TERMINAL_CHANNEL);
    this.terminalNativeAttached = false;
  }

  private attachConnectionNative(): void {
    if (this.connectionNativeAttached) return;
    const runtime = window.runtime;
    if (!runtime) {
      throw new Error('desktop bridge: window.runtime is unavailable');
    }
    runtime.EventsOn(KIMI_CONNECTION_CHANNEL, this.onNativeConnectionPayload);
    this.connectionNativeAttached = true;
  }

  private detachConnectionNative(): void {
    if (!this.connectionNativeAttached) return;
    window.runtime?.EventsOff(KIMI_CONNECTION_CHANNEL);
    this.connectionNativeAttached = false;
  }

  /** Wails delivers each `kimi:connection` `EventsEmit` argument positionally. */
  private onNativeConnectionPayload = (...args: unknown[]): void => {
    const raw = args[0];
    let state: DesktopConnectionState;
    try {
      state = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DesktopConnectionState;
    } catch {
      return; // malformed frame — drop
    }
    if (state.state !== 'connected' && state.state !== 'disconnected') return;
    for (const listener of Array.from(this.connectionListeners)) listener(state.state);
  };

  /** Wails delivers each `kimi:terminal` `EventsEmit` argument positionally. */
  private onNativeTerminalPayload = (...args: unknown[]): void => {
    const raw = args[0];
    let event: DesktopTerminalEvent;
    try {
      // The shell emits a JSON object; tolerate a JSON string too.
      event = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DesktopTerminalEvent;
    } catch {
      return; // malformed frame — drop, mirroring the IPC decoder's tolerance
    }
    for (const listener of Array.from(this.terminalListeners)) listener(event);
  };

  /** Wails delivers each `kimi:stream` `EventsEmit` argument positionally. */
  private onNativeStreamPayload = (...args: unknown[]): void => {
    const raw = args[0];
    let event: DesktopStreamEvent;
    try {
      // The shell emits a JSON object; tolerate a JSON string too.
      event = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DesktopStreamEvent;
    } catch {
      return; // malformed frame — drop, mirroring the IPC decoder's tolerance
    }
    for (const listener of Array.from(this.streamListeners)) listener(event);
  };

  /** Wails delivers each `EventsEmit` argument positionally. */
  private onNativePayload = (...args: unknown[]): void => {
    const raw = args[0];
    let payload: DesktopEventPayload;
    try {
      // The shell emits a JSON object; tolerate a JSON string too.
      payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DesktopEventPayload;
    } catch {
      return; // malformed frame — drop, mirroring the IPC decoder's tolerance
    }
    // One `kimi:event` channel carries both envelopes: the Phase 0 raw klient
    // agent event (contract C) and the Phase 1 kimi-web `WireEvent` (contract F).
    // The same parsed frame is handed to both listener sets; each consumer
    // interprets `payload.event` per its own contract.
    for (const listener of [...this.listeners]) listener(payload);
    for (const listener of [...this.productListeners]) listener(payload as ProductEventPayload);
  };
}
