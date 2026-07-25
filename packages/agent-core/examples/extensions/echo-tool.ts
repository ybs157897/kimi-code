/**
 * Example extension: register a custom tool the model can call.
 *
 * The tool echoes back its argument. Demonstrates `api.registerTool` with an
 * in-process execute callback (no RPC bounce).
 */
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI): void => {
  api.registerTool({
    name: 'echo',
    description: 'Echo back the provided message. Use to verify tool wiring.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The text to echo back.' },
      },
      required: ['message'],
    },
    async execute({ args }) {
      const message = typeof args['message'] === 'string' ? args['message'] : '';
      return { output: `echo: ${message}` };
    },
  });
};
