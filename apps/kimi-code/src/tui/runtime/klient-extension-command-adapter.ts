import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  ExtensionCommandActivation,
  ExtensionCommandPort,
} from './extension-command-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientAgentFacade = ReturnType<KlientSessionFacade['agent']>;

interface KlientExtensionAgentFacade {
  readonly extensions: {
    activateCommand(
      input: Parameters<KlientAgentFacade['extensions']['activateCommand']>[0],
    ): ReturnType<KlientAgentFacade['extensions']['activateCommand']>;
  };
}

interface KlientExtensionSessionFacade {
  readonly extensions: {
    listCommands(): ReturnType<KlientSessionFacade['extensions']['listCommands']>;
    reload(): Promise<unknown>;
  };
  agent(agentId: string): KlientExtensionAgentFacade;
}

/**
 * Bridge the Klient session/agent extension facades into the same TUI port.
 * Klient activation is engine-owned: it enqueues prompt commands itself, so
 * the adapter deliberately returns no prompt for the TUI to submit again.
 */
export function createKlientExtensionCommandPort(
  session: KlientExtensionSessionFacade,
  agentId = 'main',
): ExtensionCommandPort {
  return {
    list: () => session.extensions.listCommands(),
    reload: async () => {
      await session.extensions.reload();
    },
    activate: async (namespacedName, args): Promise<ExtensionCommandActivation | undefined> => {
      const separator = namespacedName.indexOf(':');
      if (separator <= 0 || separator === namespacedName.length - 1) {
        throw new Error(`Invalid extension command name: ${namespacedName}`);
      }
      const activated = await session.agent(agentId).extensions.activateCommand({
        extensionId: namespacedName.slice(0, separator),
        name: namespacedName.slice(separator + 1),
        args: args.length > 0 ? args : undefined,
      });
      if (!activated) {
        throw new Error(`Extension command "${namespacedName}" is unavailable.`);
      }
      return undefined;
    },
  };
}
