/**
 * Extension runner — dispatches events to loaded extensions and manages their
 * runtime lifecycle for a single session.
 *
 * One runner is created per session (after the main agent is built). It binds
 * the loaded extensions to that session's agent so action methods and event
 * contexts can reach the live runtime. Events are fired from the existing
 * turn / permission / session hook points (see the integration in
 * `agent/turn`, `agent/permission/policies/pre-tool-call-hook`, and `session`).
 */

import type { ExtensionContext, ExtensionEvent, ExtensionEventInput, ExtensionLoadError, ToolCallEventResult } from './types';
import type { Extension } from './types';

/** Actions the runner delegates to, bound from the live agent/session. */
export interface ExtensionRuntimeActions {
  readonly cwd: string;
  readonly sessionId: string;
  sendUserMessage(content: string): void;
  notify(message: string): void;
  setModel(modelAlias: string): Promise<boolean>;
  setActiveTools(toolNames: readonly string[]): void;
  getActiveTools(): readonly string[];
}

/** Error record surfaced to whoever owns the runner (e.g. logged by the session). */
export interface ExtensionError {
  readonly extensionPath: string;
  readonly event: string;
  readonly error: string;
  readonly stack?: string;
}

export type ExtensionErrorListener = (error: ExtensionError) => void;

export class ExtensionRunner {
  private readonly extensions: readonly Extension[];
  private actions: ExtensionRuntimeActions | undefined;
  private readonly errorListeners = new Set<ExtensionErrorListener>();
  private staleMessage: string | undefined;

  constructor(extensions: readonly Extension[]) {
    this.extensions = extensions;
  }

  /** Bind the runner to a live session/agent. Required before emit()/createContext(). */
  bind(actions: ExtensionRuntimeActions): void {
    this.actions = actions;
    this.staleMessage = undefined;
  }

  /** Mark this runner stale (e.g. on reload). Subsequent emit/context calls throw. */
  invalidate(message?: string): void {
    this.staleMessage ??= message ?? 'Extension runtime is stale after reload.';
  }

  hasHandlers(eventType: ExtensionEvent['type']): boolean {
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(eventType);
      if (handlers && handlers.length > 0) return true;
    }
    return false;
  }

  /** Number of loaded extensions (zero means nothing was found/loaded). */
  get size(): number {
    return this.extensions.length;
  }

  onError(listener: ExtensionErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private emitError(error: ExtensionError): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private assertActive(): void {
    if (this.staleMessage !== undefined) throw new Error(this.staleMessage);
  }

  /** Build an ExtensionContext backed by the bound runtime. */
  createContext(): ExtensionContext {
    const actions = this.actions;
    if (!actions) {
      throw new Error('Extension runner is not bound to a session yet.');
    }
    const assertActive = (): void => this.assertActive();
    return {
      get cwd() {
        assertActive();
        return actions.cwd;
      },
      get sessionId() {
        assertActive();
        return actions.sessionId;
      },
      sendUserMessage(content) {
        assertActive();
        actions.sendUserMessage(content);
      },
      notify(message) {
        assertActive();
        actions.notify(message);
      },
      setModel(modelAlias) {
        assertActive();
        return actions.setModel(modelAlias);
      },
      setActiveTools(toolNames) {
        assertActive();
        actions.setActiveTools(toolNames);
      },
      getActiveTools() {
        assertActive();
        return actions.getActiveTools();
      },
    };
  }

  /**
   * Fire an event at all matching handlers. `sessionId` is filled in from the
   * bound session. Returns the first blocking `ToolCallEventResult` for
   * tool_call events (used by the permission hook to deny a call); other event
   * types' return values are ignored.
   */
  async emit(input: ExtensionEventInput): Promise<ToolCallEventResult | undefined> {
    this.assertActive();
    const ctx = this.createContext();
    // Inject sessionId from the bound runtime so call sites stay clean.
    const event = { ...input, sessionId: this.actions!.sessionId } as ExtensionEvent;
    let blocking: ToolCallEventResult | undefined;
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(event.type);
      if (!handlers || handlers.length === 0) continue;
      for (const handler of handlers) {
        try {
          const result = (await handler(event, ctx)) as ToolCallEventResult | undefined;
          if (event.type === 'tool_call' && result?.block) {
            blocking = result;
            return blocking;
          }
        } catch (error) {
          this.emitError({
            extensionPath: ext.path,
            event: event.type,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
    return blocking;
  }
}

/** Convenience: load errors collected separately so the session can surface them. */
export type { ExtensionLoadError };
