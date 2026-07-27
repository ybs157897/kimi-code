import type { KimiSlashCommand } from './types';
import type { PluginCommandDefinition } from '../runtime/session-plugin-commands-port';

export type { PluginCommandDefinition } from '../runtime/session-plugin-commands-port';

export interface PluginSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  /** Maps a namespaced command name (`plugin:command`) to its markdown body. */
  readonly commandMap: ReadonlyMap<string, string>;
}

export function pluginCommandName(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

export function buildPluginSlashCommands(
  defs: readonly PluginCommandDefinition[],
): PluginSlashCommands {
  const commandMap = new Map<string, string>();
  const commands = defs.map((def) => {
    const commandName = pluginCommandName(def.pluginId, def.name);
    commandMap.set(commandName, def.body);
    return {
      name: commandName,
      aliases: [],
      description: def.description,
    } satisfies KimiSlashCommand;
  });
  return { commands, commandMap };
}
