/**
 * `extension` domain (L3) — public contracts for code-based extensions.
 *
 * Defines the registration API exposed to extension modules, their tools,
 * commands, events, runtime context, and the loaded contribution snapshot.
 * Pure contract; no scoped state.
 */

export interface ExtensionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: 'inline' | 'deferred';
}

export interface ExtensionToolResult {
  readonly output: string;
  readonly isError?: boolean;
  readonly message?: string;
}

export interface ExtensionToolContext {
  readonly args: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly toolCallId: string;
}

export interface ExtensionTool extends ExtensionToolDefinition {
  readonly execute: (
    context: ExtensionToolContext,
  ) => ExtensionToolResult | Promise<ExtensionToolResult>;
}

export interface ExtensionCommand {
  readonly name: string;
  readonly description: string;
  readonly prompt?: (args: string) => string | Promise<string>;
}

export interface ExtensionCommandDefinition {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
}

export type ExtensionEvent =
  | { readonly type: 'session_start'; readonly sessionId: string }
  | { readonly type: 'session_shutdown'; readonly sessionId: string }
  | {
      readonly type: 'turn_start';
      readonly sessionId: string;
      readonly prompt: string;
    }
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

export interface ToolCallEventResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface ExtensionContext {
  readonly cwd: string;
  readonly sessionId: string;
  sendUserMessage(content: string): void;
  notify(message: string): void;
  setModel(modelAlias: string): Promise<boolean>;
  setActiveTools(toolNames: readonly string[]): void;
  getActiveTools(): readonly string[];
}

export type ExtensionHandler = (
  event: ExtensionEvent,
  context: ExtensionContext,
) => unknown;

export interface ExtensionAPI {
  on(
    event: 'session_start',
    handler: (
      event: Extract<ExtensionEvent, { type: 'session_start' }>,
      context: ExtensionContext,
    ) => unknown,
  ): void;
  on(
    event: 'session_shutdown',
    handler: (
      event: Extract<ExtensionEvent, { type: 'session_shutdown' }>,
      context: ExtensionContext,
    ) => unknown,
  ): void;
  on(
    event: 'turn_start',
    handler: (
      event: Extract<ExtensionEvent, { type: 'turn_start' }>,
      context: ExtensionContext,
    ) => unknown,
  ): void;
  on(
    event: 'turn_end',
    handler: (
      event: Extract<ExtensionEvent, { type: 'turn_end' }>,
      context: ExtensionContext,
    ) => unknown,
  ): void;
  on(
    event: 'tool_call',
    handler: (
      event: Extract<ExtensionEvent, { type: 'tool_call' }>,
      context: ExtensionContext,
    ) => ToolCallEventResult | void | Promise<ToolCallEventResult | void>,
  ): void;
  on(
    event: 'tool_result',
    handler: (
      event: Extract<ExtensionEvent, { type: 'tool_result' }>,
      context: ExtensionContext,
    ) => unknown,
  ): void;
  registerTool(tool: ExtensionTool): void;
  registerCommand(name: string, command: Omit<ExtensionCommand, 'name'>): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface LoadedExtension {
  readonly path: string;
  readonly resolvedPath: string;
  readonly id: string;
  readonly handlers: Map<ExtensionEventName, ExtensionHandler[]>;
  readonly tools: Map<string, ExtensionTool>;
  readonly commands: Map<string, ExtensionCommand>;
}

export interface ExtensionLoadError {
  readonly path: string;
  readonly error: string;
}

export interface ExtensionLoadResult {
  readonly extensions: readonly LoadedExtension[];
  readonly errors: readonly ExtensionLoadError[];
}

export interface ExtensionManifest {
  readonly extensions?: readonly string[];
}
