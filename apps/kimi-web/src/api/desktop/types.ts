// apps/kimi-web/src/api/desktop/types.ts
// Phase 0 desktop bridge contracts — the webview side of the Wails shell.
//
// Mirrors frozen contract C from docs/plan/desktop-product.md: the bound
// `App` surface (JSON-string returns, parsed here in TS) and the `kimi:event`
// channel whose payload is `{ sessionId, agentId, event }` with `event.type`
// discriminating the klient agent event.
//
// Per the kimi-web decoupling rule (see apps/kimi-web/AGENTS.md) the agent
// event shapes are re-implemented locally instead of importing klient /
// agent-core; they mirror `packages/klient/src/contract/agent/events.ts`.
//
// Phase 1 (product projection layer, docs/plan/desktop-product.md §11) adds the
// `desktopProduct` surface (frozen contracts E + F): `ProductCall` forwards a
// product method whose args/result are kimi-web wire JSON, and `ProductSubscribe`
// opens the projected product stream whose frames are kimi-web `WireEvent`s —
// the same shapes the daemon WS path consumes, imported from `../daemon/wire`.

import type { WireEvent } from '../daemon/wire';

/** The Wails event channel the shell emits agent events on (contract C). */
export const KIMI_EVENT_CHANNEL = 'kimi:event';

// ---------------------------------------------------------------------------
// Wails globals — present only inside the desktop shell's webview.
// ---------------------------------------------------------------------------

/**
 * Raw Wails binding surface for the bound `App` object (contract C). The Go
 * side stays thin and returns JSON strings; the typed wrapper in `bridge.ts`
 * parses them into the result types below. Methods reject when the Go method
 * returns an error.
 */
export interface WailsAppBindings {
  /** Sidecar / IPC health. */
  Hello(): Promise<string>;
  /** klient global `sessions.list`, as a JSON page of session summaries. */
  ListSessions(): Promise<string>;
  /** Creates a session; JSON `{ sessionId, … }`. */
  CreateSession(): Promise<string>;
  /** klient agent prompt. */
  Submit(sessionId: string, agentId: string, text: string): Promise<void>;
  /** Aborts the in-flight turn. */
  Cancel(sessionId: string, agentId: string): Promise<void>;
  /**
   * Forward a `desktopProduct` method (frozen contract F). `argsJSON` is the
   * JSON-encoded positional-args array carrying the kimi-web request wire; the
   * returned string is the kimi-web response wire JSON (the unwrapped
   * `WireEnvelope.data` the daemon REST surface returns for that endpoint).
   */
  ProductCall(method: string, argsJSON: string): Promise<string>;
  /**
   * Subscribe the session/agent product stream (frozen contract F). `cursorJSON`
   * is an optional resume-cursor object (`{epoch?, after_seq?}`) as JSON, or an
   * empty string for a fresh live subscription; the sidecar replays journaled
   * frames after `after_seq` or pushes a `resync_required` frame.
   */
  ProductSubscribe(sessionId: string, agentId: string, cursorJSON: string): Promise<void>;
  /** Detach the session/agent product stream (frozen contract F). */
  ProductUnsubscribe(sessionId: string, agentId: string): Promise<void>;
}

/**
 * The subset of the Wails v2 runtime the bridge uses. Wails injects
 * `window.runtime` (and `window.go`) into the webview before page scripts
 * run; both are absent in a plain browser, which selects the dev mock.
 */
export interface WailsRuntime {
  EventsOn(eventName: string, callback: (...args: unknown[]) => void): void;
  EventsOff(eventName: string, ...additionalEventNames: string[]): void;
}

declare global {
  interface Window {
    /** Wails v2 bindings, keyed by Go package then bound struct name. */
    go?: { main?: { App?: WailsAppBindings } };
    /** Wails v2 runtime (event bus, window controls, …). */
    runtime?: WailsRuntime;
  }
}

// ---------------------------------------------------------------------------
// Parsed bind-method results (contract C: the Go side returns JSON strings).
// ---------------------------------------------------------------------------

/**
 * `Hello()` health info. The exact fields are owned by the shell (M3); kept
 * loose in Phase 0 — the demo renders it verbatim.
 */
export type DesktopHelloInfo = Record<string, unknown>;

/**
 * One session row — mirrors klient `sessionSummarySchema`
 * (`packages/klient/src/contract/global/sessions.ts`).
 */
export interface DesktopSessionSummary {
  id: string;
  workspaceId: string;
  cwd?: string;
  title?: string;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  custom?: Record<string, unknown>;
}

/** Mirrors klient `pageOf(sessionSummary)` — the `sessions.list` output. */
export interface DesktopSessionListPage {
  items: DesktopSessionSummary[];
  nextCursor?: string;
}

/**
 * `CreateSession()` result — contract C fixes `{ sessionId, … }`. `agentId`
 * is present when the shell already bound the session's main agent; callers
 * fall back to the conventional `'main'` id otherwise.
 */
export interface DesktopSessionHandle {
  sessionId: string;
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Agent events — local mirror of the klient agent event stream (Phase 0
// subset; the full union has ~40 types). `type` discriminates; events outside
// the subset arrive intact as `DesktopUnknownAgentEvent`.
// ---------------------------------------------------------------------------

/** Mirrors klient `tokenUsageSchema`. */
export interface DesktopTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

export interface DesktopTurnStartedEvent {
  type: 'turn.started';
  turnId: number;
  /** Protocol `PromptOrigin` union — mirrored as `unknown`. */
  origin?: unknown;
  prompt?: string;
}

export interface DesktopTurnEndedEvent {
  type: 'turn.ended';
  turnId: number;
  reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  /** Protocol `KimiErrorPayload` — mirrored as `unknown`. */
  error?: unknown;
  durationMs?: number;
}

export interface DesktopTurnStepStartedEvent {
  type: 'turn.step.started';
  turnId: number;
  step: number;
  stepId?: string;
}

export interface DesktopTurnStepCompletedEvent {
  type: 'turn.step.completed';
  turnId: number;
  step: number;
  stepId?: string;
  usage?: DesktopTokenUsage;
  finishReason?: string;
}

export interface DesktopAssistantDeltaEvent {
  type: 'assistant.delta';
  turnId: number;
  delta: string;
}

export interface DesktopThinkingDeltaEvent {
  type: 'thinking.delta';
  turnId: number;
  delta: string;
}

export interface DesktopToolCallStartedEvent {
  type: 'tool.call.started';
  turnId: number;
  toolCallId: string;
  name: string;
  args: unknown;
  description?: string;
}

export interface DesktopToolCallDeltaEvent {
  type: 'tool.call.delta';
  turnId: number;
  toolCallId: string;
  name?: string;
  argumentsPart?: string;
}

export interface DesktopToolProgressEvent {
  type: 'tool.progress';
  turnId: number;
  toolCallId: string;
  update: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

export interface DesktopToolResultEvent {
  type: 'tool.result';
  turnId: number;
  toolCallId: string;
  output: unknown;
  isError?: boolean;
  synthetic?: boolean;
}

export interface DesktopPromptCompletedEvent {
  type: 'prompt.completed';
  promptId: string;
  /** ISO 8601 datetime string on the wire. */
  finishedAt: string;
  reason?: 'completed' | 'failed' | 'blocked';
}

export interface DesktopPromptAbortedEvent {
  type: 'prompt.aborted';
  promptId: string;
  /** ISO 8601 datetime string on the wire. */
  abortedAt: string;
}

export interface DesktopErrorEvent {
  type: 'error';
  message: string;
  [key: string]: unknown;
}

export interface DesktopWarningEvent {
  type: 'warning';
  message: string;
  code?: string;
}

export interface DesktopNoticeEvent {
  type: 'notice';
  message: string;
  code?: string;
}

export interface DesktopAgentStatusUpdatedEvent {
  type: 'agent.status.updated';
  phase?: string;
  [key: string]: unknown;
}

/** Any agent event type outside the Phase 0 subset — kept structurally open. */
export interface DesktopUnknownAgentEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * One agent event as carried on `kimi:event`. Discriminate on `type`; the
 * known members are the Phase 0 rendering subset, the unknown member keeps
 * the full klient stream representable.
 */
export type DesktopAgentEvent =
  | DesktopTurnStartedEvent
  | DesktopTurnEndedEvent
  | DesktopTurnStepStartedEvent
  | DesktopTurnStepCompletedEvent
  | DesktopAssistantDeltaEvent
  | DesktopThinkingDeltaEvent
  | DesktopToolCallStartedEvent
  | DesktopToolCallDeltaEvent
  | DesktopToolProgressEvent
  | DesktopToolResultEvent
  | DesktopPromptCompletedEvent
  | DesktopPromptAbortedEvent
  | DesktopErrorEvent
  | DesktopWarningEvent
  | DesktopNoticeEvent
  | DesktopAgentStatusUpdatedEvent
  | DesktopUnknownAgentEvent;

/** The `kimi:event` payload (contract C): one agent event scoped to a session/agent. */
export interface DesktopEventPayload {
  sessionId: string;
  agentId: string;
  event: DesktopAgentEvent;
}

/**
 * The Phase 1 product stream envelope (frozen contract F). Same `{sessionId,
 * agentId, event}` shape as contract C, but `event` is a kimi-web `WireEvent`
 * (the `event.*` frames from `../daemon/wire`) instead of a raw klient event —
 * the desktop product layer projects klient agent events → `WireEvent` with the
 * same mapping the daemon WS path consumes, so kimi-web's existing
 * `toAppEvent` → `eventReducer` pipeline drives the real transcript UI unchanged.
 */
export interface ProductEventPayload {
  sessionId: string;
  agentId: string;
  event: WireEvent;
}

/**
 * Product-stream resume cursor (v2 sync). `afterSeq` is the last product seq the
 * client received; `epoch` is the stream epoch it observed. The bridge serializes
 * this to the sidecar's snake_case listen arg (`{epoch, after_seq}`). Absent →
 * a fresh live subscription.
 */
export interface ProductStreamCursor {
  epoch?: string;
  afterSeq?: number;
}

// ---------------------------------------------------------------------------
// Bridge surface — implemented identically by the Wails wrapper and the dev
// mock, so the demo renders the same with and without the Go shell.
// ---------------------------------------------------------------------------

export interface DesktopBridge {
  /** Which transport backs this bridge — informational (demo badge). */
  readonly kind: 'wails' | 'mock';
  Hello(): Promise<DesktopHelloInfo>;
  ListSessions(): Promise<DesktopSessionListPage>;
  CreateSession(): Promise<DesktopSessionHandle>;
  Submit(sessionId: string, agentId: string, text: string): Promise<void>;
  Cancel(sessionId: string, agentId: string): Promise<void>;
  /**
   * Subscribe to `kimi:event` payloads. Returns an unsubscribe function; the
   * native Wails listener is released when the last subscriber leaves.
   */
  onEvent(callback: (payload: DesktopEventPayload) => void): () => void;
  /**
   * Forward a `desktopProduct` method (frozen contracts E + F). `argsJSON` is
   * the JSON-encoded positional-args array carrying the kimi-web request wire;
   * resolves to the kimi-web response wire JSON (the unwrapped `WireEnvelope.data`).
   */
  ProductCall(method: string, argsJSON: string): Promise<string>;
  /**
   * Subscribe the session/agent product stream (frozen contract F), optionally
   * resuming from a cursor so a reconnect is caught up from the journal (or told
   * to resync). Omitting the cursor subscribes live from the current head.
   */
  ProductSubscribe(sessionId: string, agentId: string, cursor?: ProductStreamCursor): Promise<void>;
  /** Detach the session/agent product stream (frozen contract F). */
  ProductUnsubscribe(sessionId: string, agentId: string): Promise<void>;
  /**
   * Subscribe to product `WireEvent` payloads re-emitted on `kimi:event`.
   * Returns an unsubscribe function; shares the native listener with `onEvent`.
   */
  onProductEvent(callback: (payload: ProductEventPayload) => void): () => void;
}
