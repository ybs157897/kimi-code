/**
 * Scenario: the interactive TUI receives one process-level runtime boundary.
 * Responsibilities: each factory exposes authentication (including managed
 * usage), environment identity, feature flags, model catalog, model config,
 * provider refresh, session export, telemetry, session control, and
 * session-agent binding without engine handles. Runtime facades are the stubs.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/tui-runtime.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientTUIRuntime } from '#/tui/runtime/tui-runtime';
import type { RuntimeFeatureState } from '#/tui/runtime/runtime-feature-flags-port';
import type { RuntimeProviderRefreshScope } from '#/tui/runtime/runtime-provider-refresh-port';

const KLIENT_SUMMARY = {
  id: 'session-klient',
  workspaceId: 'workspace-klient',
  cwd: '/workspace/klient',
  title: 'Klient session',
  createdAt: 30,
  updatedAt: 40,
  archived: false,
};

const FEATURE = {
  id: 'example-feature',
  title: 'Example feature',
  description: 'Exercises runtime composition.',
  surface: 'tui' as const,
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FEATURE',
  defaultEnabled: false,
  enabled: true,
  source: 'env' as const,
  configValue: false,
} satisfies RuntimeFeatureState;

const SESSION_EXPORT_INPUT = {
  sessionId: 'session-export',
  version: '1.2.3',
  installSource: 'example-install',
  shellEnv: {
    term: 'xterm-256color',
    termProgram: 'example-terminal',
    termProgramVersion: '4.5.6',
    multiplexer: 'example-multiplexer',
    shell: '/bin/example-shell',
  },
  includeGlobalLog: true,
  outputPath: '/tmp/example-session.zip',
};

const SESSION_EXPORT_MANIFEST = {
  sessionId: 'session-export',
  exportedAt: '2026-07-27T00:00:00.000Z',
  kimiCodeVersion: '1.2.3',
  wireProtocolVersion: '1',
  os: 'example-os',
  nodejsVersion: 'v24.15.0',
  sessionFirstActivity: '2026-07-26T22:00:00.000Z',
  sessionLastActivity: '2026-07-26T23:00:00.000Z',
  title: 'Example session',
  workspaceDir: '/workspace/example',
  sessionLogPath: '/logs/session.log',
  globalLogPath: '/logs/global.log',
  desktopLogPath: '/logs/desktop.log',
  webLogPath: '/logs/web.log',
  installSource: 'example-install',
  shellEnv: SESSION_EXPORT_INPUT.shellEnv,
};

describe('TUI runtime (process-level port composition)', () => {
  it('exposes the composed Klient ports when a session is bound', async () => {
    const track = vi.fn();
    const replace = vi.fn(async () => undefined);
    const removeProvider = vi.fn(async () => undefined);
    const agent = {};
    const session = {
      agent: vi.fn(() => agent),
    };
    const runtimeFacade = {
      klient: {
        global: {
          env: vi.fn(async () => ({ homeDir: '/tmp/kimi-v2' })),
          flags: { list: vi.fn(async () => []) },
          config: {
            diagnostics: vi.fn(async () => []),
            reload: vi.fn(async () => undefined),
            set: vi.fn(async () => undefined),
            replace,
            get: vi.fn(async (domain: string) =>
              domain === 'defaultModel' ? 'klient-model' : undefined,
            ),
          },
          kosong: {
            removeProvider,
            listModels: vi.fn(async () => [
              {
                provider: 'klient-provider',
                model: 'klient-model',
                max_context_size: 64_000,
              },
            ]),
            listProviders: vi.fn(async () => [
              {
                id: 'klient-provider',
                type: 'anthropic',
                status: 'connected' as const,
                has_api_key: true,
              },
            ]),
          },
          sessions: {
            list: vi.fn(async () => ({ items: [KLIENT_SUMMARY] })),
          },
        },
        session: vi.fn(() => session),
      },
      telemetry: {
        track,
        setContext: vi.fn(),
      },
      close: vi.fn(async () => undefined),
    };

    const runtime = await createKlientTUIRuntime(
      runtimeFacade as unknown as Parameters<typeof createKlientTUIRuntime>[0],
    );

    runtime.telemetry.track('runtime_ready', { engine: 'klient' });
    const catalog = await runtime.models.load();
    await runtime.modelConfig.apply({ defaultModel: 'klient-model' });
    await runtime.modelConfig.removeProvider('klient-provider');
    const sessions = await runtime.sessionControl.sessions.list();
    const bound = runtime.bindSession('session-klient');

    expect(runtime.environment.homeDir).toBe('/tmp/kimi-v2');
    expect(catalog.defaultModel).toBe('klient-model');
    expect(Object.keys(catalog.models)).toEqual(['klient-model']);
    expect(Object.keys(catalog.providers)).toEqual(['klient-provider']);
    expect(replace).toHaveBeenCalledExactlyOnceWith({
      domain: 'defaultModel',
      value: 'klient-model',
      target: 'user',
    });
    expect(removeProvider).toHaveBeenCalledExactlyOnceWith('klient-provider');
    expect(track).toHaveBeenCalledWith('runtime_ready', { engine: 'klient' });
    expect(sessions).toEqual([
      {
        id: 'session-klient',
        workDir: '/workspace/klient',
        title: 'Klient session',
        lastPrompt: undefined,
        createdAt: 30,
        updatedAt: 40,
        archived: false,
      },
    ]);
    expect({ sessionId: bound.sessionId, agentId: bound.agentId }).toEqual({
      sessionId: 'session-klient',
      agentId: 'main',
    });
  });

  it('composes Klient plugin commands and session refresh across their native scopes', async () => {
    const listCommands = vi.fn(async () => [
      {
        pluginId: 'example-plugin',
        name: 'review',
        description: 'Review the current change.',
        body: 'Review this change.',
        path: '/plugins/example/commands/review.md',
      },
    ]);
    const activatePluginCommand = vi.fn(async () => undefined);
    const reloadPlugins = vi.fn(async () => ({
      added: [],
      removed: [],
      errors: [],
    }));
    const reloadConfig = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const restore = vi.fn(async () => true);
    const session = {
      agent: vi.fn(() => ({ activatePluginCommand })),
      close,
      restore,
    };
    const runtime = await createKlientTUIRuntime({
      klient: {
        global: {
          env: vi.fn(async () => ({ homeDir: '/tmp/kimi-v2' })),
          flags: { list: vi.fn(async () => []) },
          config: {
            diagnostics: vi.fn(async () => []),
            reload: reloadConfig,
          },
          plugins: { listCommands, reload: reloadPlugins },
        },
        session: vi.fn(() => session),
      },
      telemetry: {
        track: vi.fn(),
        setContext: vi.fn(),
      },
      close: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createKlientTUIRuntime>[0]);
    const bound = runtime.bindSession('session-klient', 'reviewer');

    await expect(bound.pluginCommands.list()).resolves.toHaveLength(1);
    await bound.pluginCommands.activate(
      'example-plugin',
      'review',
      'focus on runtime boundaries',
    );
    await bound.refresh.reload();

    expect(listCommands).toHaveBeenCalledOnce();
    expect(activatePluginCommand).toHaveBeenCalledExactlyOnceWith({
      pluginId: 'example-plugin',
      commandName: 'review',
      args: 'focus on runtime boundaries',
    });
    expect(reloadConfig).toHaveBeenCalledOnce();
    expect(reloadPlugins).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('maps the neutral session export contract to the Klient facade', async () => {
    const exportSession = vi.fn(async () => ({
      zipPath: '/tmp/example-session.zip',
      entries: ['manifest.json', 'wire.jsonl'],
      sessionDir: '/sessions/session-export',
      manifest: SESSION_EXPORT_MANIFEST,
    }));
    const runtime = await createKlientTUIRuntime({
      klient: {
        global: {
          env: vi.fn(async () => ({ homeDir: '/tmp/kimi-v2' })),
          sessionExport: { export: exportSession },
        },
      },
      telemetry: {
        track: vi.fn(),
        setContext: vi.fn(),
      },
      close: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createKlientTUIRuntime>[0]);

    const result = await runtime.sessionExport.export(SESSION_EXPORT_INPUT);

    expect(exportSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-export',
      version: '1.2.3',
      installSource: 'example-install',
      shellEnv: SESSION_EXPORT_INPUT.shellEnv,
      includeGlobalLog: true,
      outputPath: '/tmp/example-session.zip',
    });
    expect(result).toEqual({
      zipPath: '/tmp/example-session.zip',
      manifest: SESSION_EXPORT_MANIFEST,
      entries: ['manifest.json', 'wire.jsonl'],
    });
  });

  it('routes Klient feature flag list with provenance through the global facade', async () => {
    const list = vi.fn(async () => [FEATURE]);
    const { runtime } = await klientFeatureFlagsRuntime({ list });

    const features = await runtime.featureFlags.list();

    expect(features).toEqual([
      {
        id: 'example-feature',
        title: 'Example feature',
        description: 'Exercises runtime composition.',
        surface: 'tui',
        env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FEATURE',
        defaultEnabled: false,
        enabled: true,
        source: 'env',
        configValue: false,
      },
    ]);
    expect(list).toHaveBeenCalledOnce();
  });

  it.each(['all', 'oauth'] as const)(
    'routes Klient %s provider refresh through the composed adapter',
    async (scope: RuntimeProviderRefreshScope) => {
      const refreshProviders = vi.fn(async () => ({
        changed: [
          {
            provider_id: `provider-${scope}`,
            provider_name: `${scope} provider`,
            added: 3,
            removed: 2,
          },
        ],
        unchanged: ['provider-stable'],
        failed: [],
      }));
      const runtimeFacade = {
        klient: {
          global: {
            env: vi.fn(async () => ({ homeDir: '/tmp/kimi-v2' })),
            kosong: { refreshProviders },
          },
        },
        telemetry: {
          track: vi.fn(),
          setContext: vi.fn(),
        },
        close: vi.fn(async () => undefined),
      };
      const runtime = await createKlientTUIRuntime(
        runtimeFacade as unknown as Parameters<
          typeof createKlientTUIRuntime
        >[0],
      );

      const result = await runtime.providerRefresh.refresh(scope);

      expect(refreshProviders).toHaveBeenCalledWith({ scope });
      expect(result).toEqual({
        changed: [
          {
            providerId: `provider-${scope}`,
            providerName: `${scope} provider`,
            added: 3,
            removed: 2,
          },
        ],
        unchanged: ['provider-stable'],
        failed: [],
      });
    },
  );

  it('routes Klient feature flag apply through config and returns refreshed provenance', async () => {
    const set = vi.fn(async () => undefined);
    const { runtime } = await klientFeatureFlagsRuntime({
      set,
      list: vi.fn(async () => [
        {
          ...FEATURE,
          enabled: false,
          source: 'config' as const,
          configValue: false,
        },
      ]),
    });

    const features = await runtime.featureFlags.apply({
      'example-feature': false,
    });

    expect(set).toHaveBeenCalledExactlyOnceWith({
      domain: 'experimental',
      patch: { 'example-feature': false },
      target: 'user',
    });
    expect(features).toEqual([
      {
        id: 'example-feature',
        title: 'Example feature',
        description: 'Exercises runtime composition.',
        surface: 'tui',
        env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FEATURE',
        defaultEnabled: false,
        enabled: false,
        source: 'config',
        configValue: false,
      },
    ]);
  });

  it('routes Klient authentication status through the global facade', async () => {
    const status = vi.fn(async () => ({
      loggedIn: true,
      provider: 'example-provider',
    }));
    const { runtime } = await klientAuthRuntime({ status });

    const result = await runtime.auth.status('example-provider');

    expect(result).toEqual({
      loggedIn: true,
      provider: 'example-provider',
    });
    expect(status).toHaveBeenCalledWith('example-provider');
  });

  it('routes Klient managed usage through the composed auth port', async () => {
    const getManagedUsage = vi.fn(async () => ({
      kind: 'ok' as const,
      summary: null,
      limits: [{ label: 'Five hour', used: 8, limit: 50 }],
      extraUsage: null,
    }));
    const { runtime } = await klientAuthRuntime({ getManagedUsage });

    await expect(
      runtime.auth.getManagedUsage('example-provider'),
    ).resolves.toEqual({
      kind: 'ok',
      summary: null,
      limits: [{ label: 'Five hour', used: 8, limit: 50 }],
      extraUsage: null,
    });
    expect(getManagedUsage).toHaveBeenCalledWith('example-provider');
  });

  it('routes Klient login through the global facade', async () => {
    const startLogin = vi.fn(async () => ({
      flow_id: 'flow-example',
      provider: 'example-provider',
      status: 'authenticated' as const,
    }));
    const { runtime } = await klientAuthRuntime({ startLogin });

    await runtime.auth.login('example-provider');

    expect(startLogin).toHaveBeenCalledWith('example-provider');
  });

  it('routes Klient logout through the global facade', async () => {
    const logout = vi.fn(async () => ({
      logged_out: true as const,
      provider: 'example-provider',
    }));
    const { runtime } = await klientAuthRuntime({ logout });

    await runtime.auth.logout('example-provider');

    expect(logout).toHaveBeenCalledWith('example-provider');
  });

  it('routes Klient readiness through the global facade', async () => {
    const ensureReady = vi.fn(async () => undefined);
    const { runtime } = await klientAuthRuntime({ ensureReady });

    await runtime.auth.ensureReady('example-model');

    expect(ensureReady).toHaveBeenCalledWith('example-model');
  });
});

interface KlientFeatureFlagsOverrides {
  readonly list?: () => Promise<readonly RuntimeFeatureState[]>;
  readonly set?: (input: {
    domain: string;
    patch: unknown;
    target?: 'user' | 'memory';
  }) => Promise<void>;
}

async function klientFeatureFlagsRuntime(
  overrides: KlientFeatureFlagsOverrides = {},
) {
  const runtimeFacade = {
    klient: {
      global: {
        auth: {
          status: vi.fn(async () => ({
            loggedIn: false,
            provider: 'example-provider',
          })),
          ensureReady: vi.fn(async () => undefined),
          startLogin: vi.fn(async () => ({
            flow_id: 'flow-example',
            provider: 'example-provider',
            status: 'authenticated' as const,
          })),
          flow: vi.fn(async () => undefined),
          cancelLogin: vi.fn(async () => ({
            cancelled: true,
            status: 'cancelled' as const,
          })),
          logout: vi.fn(async () => ({
            logged_out: true as const,
            provider: 'example-provider',
          })),
        },
        env: vi.fn(async () => ({ homeDir: '/tmp/kimi-v2' })),
        flags: {
          list: overrides.list ?? vi.fn(async () => []),
        },
        config: {
          set: overrides.set ?? vi.fn(async () => undefined),
        },
      },
    },
    telemetry: {
      track: vi.fn(),
      setContext: vi.fn(),
    },
    close: vi.fn(async () => undefined),
  };
  return {
    runtime: await createKlientTUIRuntime(
      runtimeFacade as unknown as Parameters<typeof createKlientTUIRuntime>[0],
    ),
  };
}

async function klientAuthRuntime(
  overrides: Partial<{
    status: (provider?: string) => Promise<unknown>;
    ensureReady: (model?: string) => Promise<void>;
    startLogin: (provider?: string) => Promise<unknown>;
    flow: (provider?: string) => Promise<unknown>;
    cancelLogin: (provider?: string) => Promise<unknown>;
    logout: (provider?: string) => Promise<unknown>;
    getManagedUsage: (provider?: string) => Promise<unknown>;
  }> = {},
) {
  const auth = {
    status:
      overrides.status ??
      vi.fn(async () => ({
        loggedIn: false,
        provider: 'example-provider',
      })),
    ensureReady: overrides.ensureReady ?? vi.fn(async () => undefined),
    startLogin:
      overrides.startLogin ??
      vi.fn(async () => ({
        flow_id: 'flow-example',
        provider: 'example-provider',
        status: 'authenticated' as const,
      })),
    flow: overrides.flow ?? vi.fn(async () => undefined),
    cancelLogin:
      overrides.cancelLogin ??
      vi.fn(async () => ({
        cancelled: true,
        status: 'cancelled' as const,
      })),
    logout:
      overrides.logout ??
      vi.fn(async () => ({
        logged_out: true as const,
        provider: 'example-provider',
      })),
    getManagedUsage:
      overrides.getManagedUsage ??
      vi.fn(async () => ({
        kind: 'error' as const,
        message: 'Managed usage unavailable.',
      })),
  };
  const runtimeFacade = {
    klient: {
      global: {
        auth,
        env: vi.fn(async () => ({ homeDir: '/tmp/kimi-v2' })),
      },
    },
    telemetry: {
      track: vi.fn(),
      setContext: vi.fn(),
    },
    close: vi.fn(async () => undefined),
  };
  return {
    auth,
    runtime: await createKlientTUIRuntime(
      runtimeFacade as unknown as Parameters<typeof createKlientTUIRuntime>[0],
    ),
  };
}
