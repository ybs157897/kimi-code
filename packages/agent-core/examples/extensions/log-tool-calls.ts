/**
 * Example extension: subscribe to tool call / tool result events.
 *
 * Demonstrates `api.on('tool_call', ...)` and `api.on('tool_result', ...)`.
 * Returning `{ block: true, reason }` from a `tool_call` handler denies the
 * call (acts like a permission deny).
 */
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI): void => {
  api.on('tool_call', (event) => {
    // event.toolName, event.toolInput, event.toolCallId, event.sessionId
    console.log(`[ext] tool_call: ${event.toolName}`);
    // Uncomment to deny a specific tool:
    // if (event.toolName === 'Bash') {
    //   return { block: true, reason: 'Bash is blocked by log-tool-calls extension.' };
    // }
  });

  api.on('tool_result', (event) => {
    console.log(
      `[ext] tool_result: ${event.toolName} ${event.isError ? 'failed' : 'ok'}`,
    );
  });
};
