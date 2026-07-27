/**
 * Runtime-neutral control plane for code-extension slash commands.
 *
 * The TUI owns namespaced command presentation while adapters translate the
 * list/reload/activate calls to the active runtime.
 */

export interface ExtensionCommandDefinition {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
}

export interface ExtensionCommandActivation {
  /**
   * Legacy runtimes return prompt text for the TUI to submit. Runtimes that
   * enqueue the prompt themselves return no activation result.
   */
  readonly prompt?: string;
}

export interface ExtensionCommandPort {
  list(): Promise<readonly ExtensionCommandDefinition[]>;
  reload(): Promise<void>;
  activate(
    namespacedName: string,
    args: string,
  ): Promise<ExtensionCommandActivation | undefined>;
}
