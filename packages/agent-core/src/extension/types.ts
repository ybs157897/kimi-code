/**
 * Code-based extension system for kimi-code (v1 runtime).
 *
 * This module mirrors the design of pi's extension system but adapts it to
 * kimi-code's v1 `agent-core`: tools register through `ToolManager`, commands
 * surface as TUI slash commands, runtime actions delegate to the agent's RPC
 * surface, and events fire from the existing turn/permission/session hook
 * points (alongside the declarative `HookEngine`, not replacing it).
 *
 * First version deliberately scopes to four capability groups:
 *   1. event subscription (api.on)
 *   2. custom tool registration (api.registerTool)
 *   3. TUI slash command registration (api.registerCommand)
 *   4. runtime actions (sendUserMessage / setModel / setActiveTools / exec)
 * UI renderers, session-replacement lifecycle, provider registration, keyboard
 * shortcuts and CLI flags are intentionally out of scope for v1.
 */

// (No host imports: the extension domain defines its own result/context types
// and does not depend on the agent/session layers, keeping it cycle-free.)

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Parameters schema is a plain JSON-schema object (matching kosong's `Tool`).
 * Extensions pass it verbatim; kimi validates tool calls against it.
 */
export interface ToolDefinition {
  /** Tool name. Must be unique across builtin/user/mcp tools. */
  readonly name: string;
  /** Description shown to the model. */
  readonly description: string;
  /** JSON-schema describing the tool's input parameters. */
  readonly parameters: Record<string, unknown>;
  /**
   * Optional disclosure hint. `'deferred'` hides the tool from the model until
   * it is explicitly loaded via progressive tool disclosure.
   */
  readonly disclosure?: 'inline' | 'deferred';
}

/**
 * Result returned by an extension-provided tool execute callback. Mirrors the
 * fields of `ExecutableToolResult` but is intentionally lax (`output` may be
 * any stringifiable) so extensions don't need to import the full core types.
 */
export interface ExtensionToolResult {
  readonly output: string;
  readonly isError?: boolean;
  readonly message?: string;
}

/** Input context handed to an extension tool's execute callback. */
export interface ExtensionToolContext {
  /** Raw parsed arguments object (already validated against the schema). */
  readonly args: Record<string, unknown>;
  /** AbortSignal that rejects when the turn is cancelled. */
  readonly signal: AbortSignal;
  /** Best-effort id of the turn that triggered the call. */
  readonly turnId: string;
  /** Best-effort id of this specific tool call. */
  readonly toolCallId: string;
}

/**
 * A tool definition plus its in-process execute callback. The execute callback
 * runs inside the core process (no RPC bounce), unlike `registerUserTool`.
 */
export interface ExtensionTool extends ToolDefinition {
  readonly execute: (
    ctx: ExtensionToolContext,
  ) => Promise<ExtensionToolResult> | ExtensionToolResult;
}

// ============================================================================
// Commands
// ============================================================================

/**
 * A slash command contributed by an extension.
 *
 * `handler` runs in-process when the user invokes `/<name> [args...]` from the
 * TUI. It receives the argument string and can drive the session via the
 * extension context passed to event handlers, or return a string that is fed
 * to the model as a prompt (prompt-style command).
 */
export interface RegisteredCommand {
  readonly name: string;
  readonly description: string;
  /**
   * If set, the command is "prompt-style": the returned string is sent to the
   * model as a user message. If undefined, the command is "action-style" and
   * the handler owns its side effects.
   */
  readonly prompt?: (args: string) => string | Promise<string>;
}

/** Shape persisted by the loader and surfaced to the TUI via RPC. */
export interface ExtensionCommandDef {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
}

// ============================================================================
// Events
// ============================================================================

export type ExtensionEvent =
  | { readonly type: 'session_start'; readonly sessionId: string }
  | { readonly type: 'session_shutdown'; readonly sessionId: string }
  | { readonly type: 'turn_start'; readonly sessionId: string; readonly prompt: string }
  | { readonly type: 'turn_end'; readonly sessionId: string }
  | {
      readonly type: 'tool_call';
      readonly sessionId: string;
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
      readonly toolCallId: string;
    }
  | {
      readonly type: 'tool_result';
      readonly sessionId: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly isError: boolean;
      readonly output: string;
    };

/**
 * Event shape accepted by {@link ExtensionRunner.emit} — same as
 * {@link ExtensionEvent} minus `sessionId`, which the runner fills in from the
 * bound session so call sites don't have to thread it through.
 */
export type ExtensionEventInput =
  | { readonly type: 'session_start' }
  | { readonly type: 'session_shutdown' }
  | { readonly type: 'turn_start'; readonly prompt: string }
  | { readonly type: 'turn_end' }
  | {
      readonly type: 'tool_call';
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
      readonly toolCallId: string;
    }
  | {
      readonly type: 'tool_result';
      readonly toolName: string;
      readonly toolCallId: string;
      readonly isError: boolean;
      readonly output: string;
    };

export type ExtensionEventName = ExtensionEvent['type'];

/**
 * Return value for a `tool_call` handler. `block` denies the tool call with
 * `reason`; `undefined` lets it proceed. (Mirrors pi's ToolCallEventResult.)
 */
export interface ToolCallEventResult {
  readonly block?: boolean;
  readonly reason?: string;
}

/** Context passed to every event handler and command handler. */
export interface ExtensionContext {
  /** Working directory of the current session. */
  readonly cwd: string;
  /** Session id of the session the handler is running under. */
  readonly sessionId: string;
  /**
   * Send a user message to the agent and trigger a turn. Throws when the
   * extension runtime is stale (after reload/session replacement).
   */
  sendUserMessage(content: string): void;
  /** Set the active model alias for the current session. */
  setModel(modelAlias: string): Promise<boolean>;
  /** Restrict the set of enabled tool names for the current session. */
  setActiveTools(toolNames: readonly string[]): void;
  /** Currently enabled tool names. */
  getActiveTools(): readonly string[];
}

/** Handler function type for events. */
export type ExtensionHandler<E extends ExtensionEvent, R = void> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

// ============================================================================
// Extension API
// ============================================================================

/**
 * The API object passed to an extension's default-exported factory function.
 *
 * Registration methods (`on`/`registerTool`/`registerCommand`) write into the
 * extension's own collections during load. Action methods (`sendUserMessage`/
 * `setModel`/...) delegate to the shared runtime and only become callable once
 * the runner is bound to a live session.
 */
export interface ExtensionAPI {
  /** Subscribe to an extension event. */
  on(
    event: 'session_start',
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: 'session_start' }>>,
  ): void;
  on(
    event: 'session_shutdown',
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: 'session_shutdown' }>>,
  ): void;
  on(
    event: 'turn_start',
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: 'turn_start' }>>,
  ): void;
  on(
    event: 'turn_end',
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: 'turn_end' }>>,
  ): void;
  on(
    event: 'tool_call',
    handler: ExtensionHandler<
      Extract<ExtensionEvent, { type: 'tool_call' }>,
      ToolCallEventResult
    >,
  ): void;
  on(
    event: 'tool_result',
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: 'tool_result' }>>,
  ): void;

  /** Register a custom tool the model can call. Executes in-process. */
  registerTool(tool: ExtensionTool): void;

  /** Register a custom TUI slash command. */
  registerCommand(name: string, command: Omit<RegisteredCommand, 'name'>): void;
}

/** Extension factory function — the default export of an extension module. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

/** A loaded extension with its registered contributions. */
export interface Extension {
  /** Path as supplied (for diagnostics). */
  readonly path: string;
  /** Resolved absolute path. */
  readonly resolvedPath: string;
  /** Stable id derived from the resolved path, used for command namespacing. */
  readonly id: string;
  /** Event handlers, keyed by event name. */
  readonly handlers: Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => unknown>>;
  /** Registered tools. */
  readonly tools: Map<string, ExtensionTool>;
  /** Registered commands. */
  readonly commands: Map<string, RegisteredCommand>;
}

/** Load failure record returned alongside successfully loaded extensions. */
export interface ExtensionLoadError {
  readonly path: string;
  readonly error: string;
}

/** Result of loading a batch of extensions. */
export interface LoadExtensionsResult {
  readonly extensions: readonly Extension[];
  readonly errors: readonly ExtensionLoadError[];
}

/** Re-exported for the loader's package.json manifest reader. */
export interface KimiManifest {
  readonly extensions?: readonly string[];
}
