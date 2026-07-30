// apps/kimi-web/src/api/desktop/bridge.ts
// Reasonix-style Wails bridge: lazily resolves `window.go.main.App` per call
// and forwards to the frozen contract C bind methods, parsing the JSON-string
// results; subscribes to the `kimi:event` channel via `window.runtime`.

import type {
  DesktopBridge,
  DesktopEventPayload,
  DesktopHelloInfo,
  DesktopSessionHandle,
  DesktopSessionListPage,
  ProductEventPayload,
  WailsAppBindings,
} from './types';
import { KIMI_EVENT_CHANNEL } from './types';

/** Parse a bind-method's JSON-string result with a method-tagged error. */
function parseResult<T>(method: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`desktop bridge: ${method} returned invalid JSON: ${String(error)}`);
  }
}

export class WailsDesktopBridge implements DesktopBridge {
  readonly kind = 'wails' as const;

  private listeners = new Set<(payload: DesktopEventPayload) => void>();
  private productListeners = new Set<(payload: ProductEventPayload) => void>();
  private nativeAttached = false;

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

  async ProductSubscribe(sessionId: string, agentId: string): Promise<void> {
    await this.bindings().ProductSubscribe(sessionId, agentId);
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
