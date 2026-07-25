/**
 * Public host API surface for code-based extensions.
 *
 * Extensions import from `@moonshot-ai/agent-core/extension`, which jiti's
 * alias table resolves to this file. It re-exports only the types and helpers
 * an extension is meant to use, keeping the rest of `agent-core` internal.
 *
 * Example extension:
 *
 * ```ts
 * import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';
 *
 * export default (api: ExtensionAPI) => {
 *   api.on('tool_result', (event) => {
 *     console.log(`[${event.toolName}] done`);
 *   });
 *   api.registerTool({
 *     name: 'my_tool',
 *     description: 'Does a thing.',
 *     parameters: { type: 'object', properties: {} },
 *     async execute({ args }) {
 *       return { output: 'ok' };
 *     },
 *   });
 * };
 * ```
 */

export type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionEventName,
  ExtensionTool,
  ExtensionToolContext,
  ExtensionToolResult,
  RegisteredCommand,
  ToolCallEventResult,
  ToolDefinition,
} from './types';
