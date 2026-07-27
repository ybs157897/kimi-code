/**
 * Scenario: plugin management crosses the TUI runtime boundary.
 * Responsibilities: legacy and Klient adapters expose neutral copied views,
 * preserve public arguments, and pass runtime errors through unchanged. Each
 * runtime plugin facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-plugins-port.test.ts
 */

import type {
  PluginInfo,
  PluginSummary,
  ReloadSummary,
  Session,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionPluginsPort } from '#/tui/runtime/klient-session-plugins-adapter';
import { createLegacySessionPluginsPort } from '#/tui/runtime/legacy-session-plugins-adapter';
import type {
  PluginInfoView,
  PluginSummaryView,
  ReloadSummaryView,
} from '#/tui/runtime/session-plugins-port';

const EXPECTED_SUMMARY: PluginSummaryView = {
  id: 'example-plugin',
  displayName: 'Example Plugin',
  version: '1.2.3',
  enabled: true,
  state: 'error',
  skillCount: 2,
  mcpServerCount: 2,
  enabledMcpServerCount: 1,
  hasErrors: true,
  source: 'github',
  originalSource: 'github.com/example/plugin',
  github: {
    owner: 'example',
    repo: 'plugin',
    ref: { kind: 'tag', value: 'v1.2.3' },
    installedSha: 'abc123',
  },
};

const EXPECTED_INFO: PluginInfoView = {
  ...EXPECTED_SUMMARY,
  root: '/plugins/example-plugin',
  installedAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  manifestKind: 'kimi-plugin-root',
  manifestPath: '/plugins/example-plugin/kimi-plugin.json',
  manifest: {
    keywords: ['example', 'testing'],
    skills: ['review', 'verify'],
    sessionStart: { skill: 'review' },
    skillInstructions: 'Follow the plugin instructions.',
    interface: {
      shortDescription: 'Example integration',
      developerName: 'Example Developer',
      websiteURL: 'https://example.test/plugin',
    },
  },
  mcpServers: [
    {
      name: 'local',
      runtimeName: 'example-plugin:local',
      enabled: true,
      transport: 'stdio',
      command: 'example-server',
      args: ['--stdio'],
      cwd: '/plugins/example-plugin',
      url: undefined,
      envKeys: ['EXAMPLE_TOKEN'],
      headerKeys: undefined,
    },
    {
      name: 'remote',
      runtimeName: 'example-plugin:remote',
      enabled: false,
      transport: 'http',
      command: undefined,
      args: undefined,
      cwd: undefined,
      url: 'https://api.example.test/mcp',
      envKeys: undefined,
      headerKeys: ['Authorization'],
    },
  ],
  shadowedManifestPath: '/plugins/example-plugin/plugin.json',
  diagnostics: [
    { severity: 'warn', message: 'Example diagnostic.' },
  ],
};

const EXPECTED_RELOAD: ReloadSummaryView = {
  added: ['added-plugin'],
  removed: ['removed-plugin'],
  errors: [{ id: 'broken-plugin', message: 'Could not load plugin.' }],
};

describe('legacy session plugin adapter', () => {
  it('list returns copied neutral summaries from the legacy Session', async () => {
    const summary = pluginSummary();
    const summaries = [summary];
    const port = createLegacySessionPluginsPort(
      legacySession({
        listPlugins: vi.fn(async () => summaries),
      }),
    );

    const result = await port.list();

    expect(result).toEqual([EXPECTED_SUMMARY]);
    expect(result).not.toBe(summaries);
    expect(result[0]).not.toBe(summary);
    expect(result[0]?.github).not.toBe(summary.github);
    expect(result[0]?.github?.ref).not.toBe(summary.github?.ref);
  });

  it('info returns a deeply copied neutral view from the legacy Session', async () => {
    const info = pluginInfo();
    const port = createLegacySessionPluginsPort(
      legacySession({
        getPluginInfo: vi.fn(async () => info),
      }),
    );

    const result = await port.info('example-plugin');

    expect(result).toEqual(EXPECTED_INFO);
    expect(result).not.toBe(info);
    expect(result.manifest).not.toBe(info.manifest);
    expect(result.manifest?.skills).not.toBe(info.manifest?.skills);
    expect(result.mcpServers).not.toBe(info.mcpServers);
    expect(result.mcpServers[0]?.args).not.toBe(info.mcpServers[0]?.args);
    expect(result.diagnostics).not.toBe(info.diagnostics);
  });

  it('info forwards the plugin id to the legacy Session', async () => {
    const getPluginInfo = vi.fn(async () => pluginInfo());
    const port = createLegacySessionPluginsPort(
      legacySession({ getPluginInfo }),
    );

    await port.info('example-plugin');

    expect(getPluginInfo).toHaveBeenCalledWith('example-plugin');
  });

  it('install forwards the source path unchanged to the legacy Session', async () => {
    const installPlugin = vi.fn(async () => pluginSummary());
    const port = createLegacySessionPluginsPort(
      legacySession({ installPlugin }),
    );

    await port.install('./plugins/example-plugin');

    expect(installPlugin).toHaveBeenCalledWith('./plugins/example-plugin');
  });

  it('install returns a copied neutral summary from the legacy Session', async () => {
    const summary = pluginSummary();
    const port = createLegacySessionPluginsPort(
      legacySession({
        installPlugin: vi.fn(async () => summary),
      }),
    );

    const result = await port.install('https://example.test/plugin.zip');

    expect(result).toEqual(EXPECTED_SUMMARY);
    expect(result).not.toBe(summary);
    expect(result.github).not.toBe(summary.github);
  });

  it('setEnabled forwards positional plugin state to the legacy Session', async () => {
    const setPluginEnabled = vi.fn(async () => undefined);
    const port = createLegacySessionPluginsPort(
      legacySession({ setPluginEnabled }),
    );

    await port.setEnabled('example-plugin', false);

    expect(setPluginEnabled).toHaveBeenCalledWith('example-plugin', false);
  });

  it('setMcpServerEnabled forwards positional server state to the legacy Session', async () => {
    const setPluginMcpServerEnabled = vi.fn(async () => undefined);
    const port = createLegacySessionPluginsPort(
      legacySession({ setPluginMcpServerEnabled }),
    );

    await port.setMcpServerEnabled('example-plugin', 'remote', true);

    expect(setPluginMcpServerEnabled).toHaveBeenCalledWith(
      'example-plugin',
      'remote',
      true,
    );
  });

  it('remove forwards the plugin id to the legacy Session', async () => {
    const removePlugin = vi.fn(async () => undefined);
    const port = createLegacySessionPluginsPort(
      legacySession({ removePlugin }),
    );

    await port.remove('example-plugin');

    expect(removePlugin).toHaveBeenCalledWith('example-plugin');
  });

  it('reload returns a deeply copied neutral summary from the legacy Session', async () => {
    const summary = reloadSummary();
    const port = createLegacySessionPluginsPort(
      legacySession({
        reloadPlugins: vi.fn(async () => summary),
      }),
    );

    const result = await port.reload();

    expect(result).toEqual(EXPECTED_RELOAD);
    expect(result).not.toBe(summary);
    expect(result.added).not.toBe(summary.added);
    expect(result.removed).not.toBe(summary.removed);
    expect(result.errors).not.toBe(summary.errors);
    expect(result.errors[0]).not.toBe(summary.errors[0]);
  });

  it('info passes a legacy Session error through unchanged', async () => {
    const failure = new Error('legacy plugin failure');
    const port = createLegacySessionPluginsPort(
      legacySession({
        getPluginInfo: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(port.info('example-plugin')).rejects.toBe(failure);
  });
});

describe('Klient session plugin adapter', () => {
  it('list returns copied neutral summaries from runtime.klient.global.plugins', async () => {
    const summary = pluginSummary();
    const summaries = [summary];
    const port = createKlientSessionPluginsPort(
      klientRuntime({
        list: vi.fn(async () => summaries),
      }),
    );

    const result = await port.list();

    expect(result).toEqual([EXPECTED_SUMMARY]);
    expect(result).not.toBe(summaries);
    expect(result[0]).not.toBe(summary);
    expect(result[0]?.github).not.toBe(summary.github);
    expect(result[0]?.github?.ref).not.toBe(summary.github?.ref);
  });

  it('info returns a deeply copied neutral view from runtime.klient.global.plugins', async () => {
    const info = pluginInfo();
    const port = createKlientSessionPluginsPort(
      klientRuntime({
        info: vi.fn(async () => info),
      }),
    );

    const result = await port.info('example-plugin');

    expect(result).toEqual(EXPECTED_INFO);
    expect(result).not.toBe(info);
    expect(result.manifest).not.toBe(info.manifest);
    expect(result.manifest?.keywords).not.toBe(info.manifest?.keywords);
    expect(result.mcpServers).not.toBe(info.mcpServers);
    expect(result.mcpServers[1]?.headerKeys).not.toBe(
      info.mcpServers[1]?.headerKeys,
    );
    expect(result.diagnostics).not.toBe(info.diagnostics);
  });

  it('info forwards the plugin id to runtime.klient.global.plugins', async () => {
    const info = vi.fn(async () => pluginInfo());
    const port = createKlientSessionPluginsPort(
      klientRuntime({ info }),
    );

    await port.info('example-plugin');

    expect(info).toHaveBeenCalledWith('example-plugin');
  });

  it('install forwards the source path unchanged to runtime.klient.global.plugins', async () => {
    const install = vi.fn(async () => pluginSummary());
    const port = createKlientSessionPluginsPort(
      klientRuntime({ install }),
    );

    await port.install('./plugins/example-plugin');

    expect(install).toHaveBeenCalledWith('./plugins/example-plugin');
  });

  it('install returns a copied neutral summary from runtime.klient.global.plugins', async () => {
    const summary = pluginSummary();
    const port = createKlientSessionPluginsPort(
      klientRuntime({
        install: vi.fn(async () => summary),
      }),
    );

    const result = await port.install('https://example.test/plugin.zip');

    expect(result).toEqual(EXPECTED_SUMMARY);
    expect(result).not.toBe(summary);
    expect(result.github).not.toBe(summary.github);
  });

  it('setEnabled forwards object input to runtime.klient.global.plugins', async () => {
    const setEnabled = vi.fn(async () => undefined);
    const port = createKlientSessionPluginsPort(
      klientRuntime({ setEnabled }),
    );

    await port.setEnabled('example-plugin', false);

    expect(setEnabled).toHaveBeenCalledWith({
      id: 'example-plugin',
      enabled: false,
    });
  });

  it('setMcpServerEnabled forwards object input to runtime.klient.global.plugins', async () => {
    const setMcpServerEnabled = vi.fn(async () => undefined);
    const port = createKlientSessionPluginsPort(
      klientRuntime({ setMcpServerEnabled }),
    );

    await port.setMcpServerEnabled('example-plugin', 'remote', true);

    expect(setMcpServerEnabled).toHaveBeenCalledWith({
      id: 'example-plugin',
      server: 'remote',
      enabled: true,
    });
  });

  it('remove forwards the plugin id to runtime.klient.global.plugins', async () => {
    const remove = vi.fn(async () => undefined);
    const port = createKlientSessionPluginsPort(
      klientRuntime({ remove }),
    );

    await port.remove('example-plugin');

    expect(remove).toHaveBeenCalledWith('example-plugin');
  });

  it('reload returns a deeply copied neutral summary from runtime.klient.global.plugins', async () => {
    const summary = reloadSummary();
    const port = createKlientSessionPluginsPort(
      klientRuntime({
        reload: vi.fn(async () => summary),
      }),
    );

    const result = await port.reload();

    expect(result).toEqual(EXPECTED_RELOAD);
    expect(result).not.toBe(summary);
    expect(result.added).not.toBe(summary.added);
    expect(result.removed).not.toBe(summary.removed);
    expect(result.errors).not.toBe(summary.errors);
    expect(result.errors[0]).not.toBe(summary.errors[0]);
  });

  it('info passes a Klient error through unchanged', async () => {
    const failure = new Error('Klient plugin failure');
    const port = createKlientSessionPluginsPort(
      klientRuntime({
        info: vi.fn(async () => {
          throw failure;
        }),
      }),
    );

    await expect(port.info('example-plugin')).rejects.toBe(failure);
  });
});

type LegacySessionPluginMethods = Pick<
  Session,
  | 'listPlugins'
  | 'getPluginInfo'
  | 'installPlugin'
  | 'setPluginEnabled'
  | 'setPluginMcpServerEnabled'
  | 'removePlugin'
  | 'reloadPlugins'
>;

function legacySession(
  overrides: Partial<LegacySessionPluginMethods> = {},
): LegacySessionPluginMethods {
  return {
    listPlugins: vi.fn(async () => []),
    getPluginInfo: vi.fn(async () => pluginInfo()),
    installPlugin: vi.fn(async () => pluginSummary()),
    setPluginEnabled: vi.fn(async () => undefined),
    setPluginMcpServerEnabled: vi.fn(async () => undefined),
    removePlugin: vi.fn(async () => undefined),
    reloadPlugins: vi.fn(async () => reloadSummary()),
    ...overrides,
  };
}

interface KlientPluginMethods {
  list(): Promise<readonly PluginSummary[]>;
  info(id: string): Promise<PluginInfo>;
  install(source: string): Promise<PluginSummary>;
  setEnabled(input: { id: string; enabled: boolean }): Promise<void>;
  setMcpServerEnabled(input: {
    id: string;
    server: string;
    enabled: boolean;
  }): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<ReloadSummary>;
}

function klientRuntime(overrides: Partial<KlientPluginMethods> = {}) {
  return {
    klient: {
      global: {
        plugins: {
          list: vi.fn(async () => []),
          info: vi.fn(async () => pluginInfo()),
          install: vi.fn(async () => pluginSummary()),
          setEnabled: vi.fn(async () => undefined),
          setMcpServerEnabled: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          reload: vi.fn(async () => reloadSummary()),
          ...overrides,
        },
      },
    },
  };
}

function pluginSummary(): PluginSummary {
  return {
    id: 'example-plugin',
    displayName: 'Example Plugin',
    version: '1.2.3',
    enabled: true,
    state: 'error',
    skillCount: 2,
    mcpServerCount: 2,
    enabledMcpServerCount: 1,
    hookCount: 1,
    commandCount: 1,
    hasErrors: true,
    source: 'github',
    originalSource: 'github.com/example/plugin',
    github: {
      owner: 'example',
      repo: 'plugin',
      ref: { kind: 'tag', value: 'v1.2.3' },
      installedSha: 'abc123',
    },
  };
}

function pluginInfo(): PluginInfo {
  return {
    ...pluginSummary(),
    root: '/plugins/example-plugin',
    installedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    manifestKind: 'kimi-plugin-root',
    manifestPath: '/plugins/example-plugin/kimi-plugin.json',
    manifest: {
      name: 'example-plugin',
      keywords: ['example', 'testing'],
      skills: ['review', 'verify'],
      sessionStart: { skill: 'review' },
      skillInstructions: 'Follow the plugin instructions.',
      interface: {
        shortDescription: 'Example integration',
        developerName: 'Example Developer',
        websiteURL: 'https://example.test/plugin',
      },
    },
    mcpServers: [
      {
        name: 'local',
        runtimeName: 'example-plugin:local',
        enabled: true,
        transport: 'stdio',
        command: 'example-server',
        args: ['--stdio'],
        cwd: '/plugins/example-plugin',
        envKeys: ['EXAMPLE_TOKEN'],
      },
      {
        name: 'remote',
        runtimeName: 'example-plugin:remote',
        enabled: false,
        transport: 'http',
        url: 'https://api.example.test/mcp',
        headerKeys: ['Authorization'],
      },
    ],
    shadowedManifestPath: '/plugins/example-plugin/plugin.json',
    diagnostics: [
      { severity: 'warn', message: 'Example diagnostic.' },
    ],
  };
}

function reloadSummary(): ReloadSummary {
  return {
    added: ['added-plugin'],
    removed: ['removed-plugin'],
    errors: [{ id: 'broken-plugin', message: 'Could not load plugin.' }],
  };
}
