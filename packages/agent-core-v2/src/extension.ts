/**
 * `extension` public facade — curated host API for code-based extensions.
 *
 * Re-exports only the contracts extension modules may import. The runtime
 * loader aliases both the legacy and v2 package subpaths to this facade.
 */

export type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionCommandDefinition,
  ExtensionContext,
  ExtensionEvent,
  ExtensionEventName,
  ExtensionTool,
  ExtensionToolContext,
  ExtensionToolDefinition,
  ExtensionToolResult,
  ToolCallEventResult,
} from '#/app/extension/extension.types';
