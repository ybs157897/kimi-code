/**
 * Example extension: register a `/hello` slash command (prompt-style).
 *
 * Prompt-style commands return a string that is sent to the model as a user
 * message. The command is namespaced as `<extensionId>:<commandName>`, so this
 * one is invoked as `/hello-command:hello` (the extension id derives from the
 * file name).
 */
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI): void => {
  api.registerCommand('hello', {
    description: 'Greet the model.',
    prompt: (args) => `Please say hello${args.length > 0 ? ` to ${args}` : ''}.`,
  });
};
