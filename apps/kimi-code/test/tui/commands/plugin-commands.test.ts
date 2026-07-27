import { describe, expect, it } from 'vitest';

import {
  buildPluginSlashCommands,
  type PluginCommandDefinition,
  pluginCommandName,
} from '#/tui/commands/plugin-commands';

describe('pluginCommandName', () => {
  it('namespaces a command with its plugin id', () => {
    expect(pluginCommandName('my-plugin', 'deploy')).toBe('my-plugin:deploy');
  });
});

describe('buildPluginSlashCommands', () => {
  it('namespaces commands and maps them to their bodies', () => {
    const definitions = [
      {
        pluginId: 'my-plugin',
        name: 'deploy',
        description: 'Deploy',
        body: 'Deploy $ARGUMENTS',
        path: '/p/deploy.md',
      },
    ] satisfies readonly PluginCommandDefinition[];

    const { commands, commandMap } = buildPluginSlashCommands(definitions);

    expect(commands).toEqual([{ name: 'my-plugin:deploy', aliases: [], description: 'Deploy' }]);
    expect(commandMap.get('my-plugin:deploy')).toBe('Deploy $ARGUMENTS');
  });

  it('returns empty commands for no defs', () => {
    const { commands, commandMap } = buildPluginSlashCommands([]);
    expect(commands).toEqual([]);
    expect(commandMap.size).toBe(0);
  });
});
