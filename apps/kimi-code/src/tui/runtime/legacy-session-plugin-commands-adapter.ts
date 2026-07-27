import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionPluginCommandsPort } from './session-plugin-commands-port';

interface LegacyPluginCommandSession {
  listPluginCommands(): ReturnType<Session['listPluginCommands']>;
  activatePluginCommand(
    pluginId: Parameters<Session['activatePluginCommand']>[0],
    commandName: Parameters<Session['activatePluginCommand']>[1],
    args: Parameters<Session['activatePluginCommand']>[2],
  ): ReturnType<Session['activatePluginCommand']>;
}

/** Bridge the legacy Session plugin-command surface into the neutral TUI port. */
export function createLegacySessionPluginCommandsPort(
  session: LegacyPluginCommandSession,
): SessionPluginCommandsPort {
  return {
    list: () => session.listPluginCommands(),
    activate: async (pluginId, commandName, args) => {
      await session.activatePluginCommand(pluginId, commandName, args);
    },
  };
}
