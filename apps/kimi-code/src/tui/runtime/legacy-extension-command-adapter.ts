import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { ExtensionCommandPort } from './extension-command-port';

interface LegacyExtensionSession {
  listExtensionCommands(): ReturnType<Session['listExtensionCommands']>;
  reloadSession(options: Parameters<Session['reloadSession']>[0]): Promise<unknown>;
  activateExtensionCommand(
    name: Parameters<Session['activateExtensionCommand']>[0],
    args: Parameters<Session['activateExtensionCommand']>[1],
  ): ReturnType<Session['activateExtensionCommand']>;
}

/** Bridge the current SDK Session into the runtime-neutral TUI port. */
export function createLegacyExtensionCommandPort(
  session: LegacyExtensionSession,
): ExtensionCommandPort {
  return {
    list: () => session.listExtensionCommands(),
    reload: async () => {
      await session.reloadSession({ forcePluginSessionStartReminder: true });
    },
    activate: (namespacedName, args) =>
      session.activateExtensionCommand(namespacedName, args),
  };
}
