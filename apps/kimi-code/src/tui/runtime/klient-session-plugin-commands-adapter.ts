import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionPluginCommandsPort } from './session-plugin-commands-port';

type Klient = KimiV2Runtime['klient'];

/** Bind the v2 app command catalog and agent command executor to one TUI session. */
export function createKlientSessionPluginCommandsPort(
  klient: Klient,
  sessionId: string,
  agentId: string,
): SessionPluginCommandsPort {
  const agent = klient.session(sessionId).agent(agentId);
  return {
    list: () => klient.global.plugins.listCommands(),
    activate: (pluginId, commandName, args) =>
      agent.activatePluginCommand({ pluginId, commandName, args }),
  };
}
