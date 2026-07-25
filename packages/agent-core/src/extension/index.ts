/**
 * Code-based extension domain (v1).
 *
 * Lets users drop TS/JS files into `.kimi-code/extensions/` (project) or
 * `~/.kimi-code/extensions/` (global) that run inside the core process:
 * subscribe to events, register tools and slash commands, and drive the
 * session via runtime actions. Loaded with jiti, reloaded via `/reload`.
 *
 * See `docs/zh|en/customization/extensions.md` for the user guide.
 */

export type {
  ExtensionAPI,
  ExtensionCommandDef,
  ExtensionContext,
  ExtensionEvent,
  ExtensionEventInput,
  ExtensionEventName,
  ExtensionLoadError,
  ExtensionTool,
  ExtensionToolContext,
  ExtensionToolResult,
  KimiManifest,
  LoadExtensionsResult,
  RegisteredCommand,
  ToolCallEventResult,
  ToolDefinition,
} from './types';

export {
  CONFIG_DIR_NAME,
  createExtensionAPI,
  discoverAndLoadExtensions,
  discoverExtensionsInDir,
  loadExtensions,
} from './loader';

export {
  ExtensionRunner,
  type ExtensionError,
  type ExtensionErrorListener,
  type ExtensionRuntimeActions,
} from './runner';

export {
  ExtensionManager,
  type ExtensionManagerOptions,
  type ExtensionReloadSummary,
} from './manager';
