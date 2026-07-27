/** Runtime-neutral plugin command metadata consumed by the TUI. */
export interface PluginCommandDefinition {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly path?: string;
}

/**
 * Plugin command catalog and activation for one active session/agent binding.
 *
 * The catalog is app-scoped in v2 while activation is agent-scoped. Keeping
 * both operations behind one TUI port prevents those engine scopes from
 * leaking into command dispatch.
 */
export interface SessionPluginCommandsPort {
  list(): Promise<readonly PluginCommandDefinition[]>;
  activate(pluginId: string, commandName: string, args: string): Promise<void>;
}
