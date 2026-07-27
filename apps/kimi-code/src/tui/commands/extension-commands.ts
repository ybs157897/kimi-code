import type { ExtensionCommandDefinition } from '../runtime/extension-command-port';
import type { KimiSlashCommand } from './types';

export interface ExtensionSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  /**
   * Namespaced extension command names (`<extensionId>:<commandName>`). Unlike
   * plugin commands, the value carries no body — extension commands are
   * resolved at activation time via `session.activateExtensionCommand`.
   */
  readonly commandNames: ReadonlySet<string>;
}

/** Namespaced name for an extension command: `<extensionId>:<commandName>`. */
export function extensionCommandName(extensionId: string, name: string): string {
  return `${extensionId}:${name}`;
}

export function buildExtensionSlashCommands(
  defs: readonly ExtensionCommandDefinition[],
): ExtensionSlashCommands {
  const commandNames = new Set<string>();
  const commands = defs.map((def) => {
    const commandName = extensionCommandName(def.extensionId, def.name);
    commandNames.add(commandName);
    return {
      name: commandName,
      aliases: [],
      description: def.description,
    } satisfies KimiSlashCommand;
  });
  return { commands, commandNames };
}
