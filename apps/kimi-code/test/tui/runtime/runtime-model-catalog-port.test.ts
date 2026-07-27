/**
 * Scenario: process-level model catalogs cross the TUI runtime boundary.
 * Responsibilities: both adapters project the same read-only snapshot,
 * reload precedes Klient reads, and missing config yields an empty catalog.
 * The legacy harness and Klient facade are the only stubbed boundaries.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-model-catalog-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientRuntimeModelCatalogPort } from '#/tui/runtime/klient-runtime-model-catalog-adapter';
import { createLegacyRuntimeModelCatalogPort } from '#/tui/runtime/legacy-runtime-model-catalog-adapter';

describe('runtime model catalog adapters', () => {
  it('preserves legacy model display config when the harness catalog loads', async () => {
    const getConfig = vi.fn(async () => ({
      models: {
        'anthropic/opus': {
          provider: 'anthropic',
          model: 'claude-opus',
          maxContextSize: 200_000,
          maxInputSize: 180_000,
          maxOutputSize: 20_000,
          capabilities: ['thinking', 'tool_use'],
          displayName: 'Claude Opus',
          reasoningKey: 'reasoning_effort',
          protocol: 'anthropic' as const,
          adaptiveThinking: true,
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
          offEffort: 'none',
          betaApi: true,
          baseUrl: 'https://api.example.test',
          overrides: {
            displayName: 'Opus (custom)',
            maxContextSize: 190_000,
            capabilities: ['thinking'],
            supportEfforts: ['high'],
          },
        },
      },
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKey: 'YOUR_API_KEY',
          baseUrl: 'https://api.example.test',
          defaultModel: 'anthropic/opus',
        },
        local: {
          type: 'openai',
          baseUrl: 'http://127.0.0.1:8080',
        },
      },
      defaultModel: 'anthropic/opus',
      thinking: { enabled: true, effort: 'high', keep: 'all' },
    }));
    const port = createLegacyRuntimeModelCatalogPort({ getConfig });

    await expect(port.load({ reload: true })).resolves.toEqual({
      models: {
        'anthropic/opus': {
          provider: 'anthropic',
          model: 'claude-opus',
          maxContextSize: 200_000,
          maxInputSize: 180_000,
          maxOutputSize: 20_000,
          capabilities: ['thinking', 'tool_use'],
          displayName: 'Claude Opus',
          reasoningKey: 'reasoning_effort',
          protocol: 'anthropic',
          adaptiveThinking: true,
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
          offEffort: 'none',
          betaApi: true,
          baseUrl: 'https://api.example.test',
          overrides: {
            displayName: 'Opus (custom)',
            maxContextSize: 190_000,
            capabilities: ['thinking'],
            supportEfforts: ['high'],
          },
        },
      },
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://api.example.test',
          defaultModel: 'anthropic/opus',
          status: 'connected',
          hasApiKey: true,
          env: undefined,
          customHeaders: undefined,
          source: undefined,
        },
        local: {
          type: 'openai',
          baseUrl: 'http://127.0.0.1:8080',
          defaultModel: undefined,
          status: 'unconfigured',
          hasApiKey: false,
          env: undefined,
          customHeaders: undefined,
          source: undefined,
        },
      },
      defaultModel: 'anthropic/opus',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(getConfig).toHaveBeenCalledWith({ reload: true });
  });

  it('returns an isolated legacy provider config view without exposing its api key', async () => {
    const env = { EXAMPLE_REGION: 'test' };
    const customHeaders = { 'X-Example': 'header-value' };
    const nested = { retries: 2 };
    const source = {
      kind: 'apiJson',
      url: 'https://catalog.example.test/api.json',
      apiKey: 'YOUR_REGISTRY_API_KEY',
      options: ['stable', nested],
    };
    const port = createLegacyRuntimeModelCatalogPort({
      getConfig: vi.fn(async () => ({
        providers: {
          example: {
            type: 'openai',
            apiKey: 'YOUR_PROVIDER_API_KEY',
            baseUrl: 'https://api.example.test',
            defaultModel: 'example/model',
            env,
            customHeaders,
            source,
          },
        },
      })),
    });

    const snapshot = await port.load();
    env.EXAMPLE_REGION = 'changed';
    customHeaders['X-Example'] = 'changed';
    nested.retries = 9;

    expect(snapshot.providers['example']).toEqual({
      type: 'openai',
      baseUrl: 'https://api.example.test',
      defaultModel: 'example/model',
      status: 'connected',
      hasApiKey: true,
      env: { EXAMPLE_REGION: 'test' },
      customHeaders: { 'X-Example': 'header-value' },
      source: {
        kind: 'apiJson',
        url: 'https://catalog.example.test/api.json',
        apiKey: 'YOUR_REGISTRY_API_KEY',
        options: ['stable', { retries: 2 }],
      },
    });
    expect(snapshot.providers['example']).not.toHaveProperty('apiKey');
  });

  it('projects Klient snake-case catalogs when the snapshot loads', async () => {
    const port = createKlientRuntimeModelCatalogPort(
      klientFacade({
        models: [
          {
            provider: 'openai',
            model: 'openai/gpt-example',
            display_name: 'GPT Example',
            max_context_size: 128_000,
            capabilities: ['tool_use'],
            support_efforts: ['medium', 'high'],
            default_effort: 'medium',
          },
        ],
        providers: [
          {
            id: 'openai',
            type: 'openai',
            base_url: 'https://api.example.test',
            default_model: 'openai/gpt-example',
            has_api_key: true,
            status: 'connected',
          },
        ],
        defaultModel: 'openai/gpt-example',
        thinking: { enabled: true, effort: 'medium' },
      }),
    );

    await expect(port.load()).resolves.toEqual({
      models: {
        'openai/gpt-example': {
          provider: 'openai',
          model: 'openai/gpt-example',
          maxContextSize: 128_000,
          capabilities: ['tool_use'],
          displayName: 'GPT Example',
          supportEfforts: ['medium', 'high'],
          defaultEffort: 'medium',
        },
      },
      providers: {
        openai: {
          type: 'openai',
          baseUrl: 'https://api.example.test',
          defaultModel: 'openai/gpt-example',
          status: 'connected',
          hasApiKey: true,
          env: undefined,
          customHeaders: undefined,
          source: undefined,
        },
      },
      defaultModel: 'openai/gpt-example',
      thinking: { enabled: true, effort: 'medium' },
    });
  });

  it('merges isolated Klient provider provenance without exposing its api key', async () => {
    const env = { EXAMPLE_REGION: 'test' };
    const customHeaders = { 'X-Example': 'header-value' };
    const nested = { retries: 2 };
    const source = {
      kind: 'apiJson',
      url: 'https://catalog.example.test/api.json',
      apiKey: 'YOUR_REGISTRY_API_KEY',
      options: ['stable', nested],
    };
    const port = createKlientRuntimeModelCatalogPort(
      klientFacade({
        providers: [
          {
            id: 'example',
            type: 'openai',
            base_url: 'https://api.example.test',
            default_model: 'example/model',
            has_api_key: true,
            status: 'connected',
          },
        ],
        providerConfigs: {
          example: {
            apiKey: 'YOUR_PROVIDER_API_KEY',
            env,
            customHeaders,
            source,
          },
        },
      }),
    );

    const snapshot = await port.load();
    env.EXAMPLE_REGION = 'changed';
    customHeaders['X-Example'] = 'changed';
    nested.retries = 9;

    expect(snapshot.providers['example']).toEqual({
      type: 'openai',
      baseUrl: 'https://api.example.test',
      defaultModel: 'example/model',
      status: 'connected',
      hasApiKey: true,
      env: { EXAMPLE_REGION: 'test' },
      customHeaders: { 'X-Example': 'header-value' },
      source: {
        kind: 'apiJson',
        url: 'https://catalog.example.test/api.json',
        apiKey: 'YOUR_REGISTRY_API_KEY',
        options: ['stable', { retries: 2 }],
      },
    });
    expect(snapshot.providers['example']).not.toHaveProperty('apiKey');
  });

  it('starts Klient catalog reads only after a requested reload settles', async () => {
    let settleReload = (): void => undefined;
    const reloadResult = new Promise<void>((resolve) => {
      settleReload = resolve;
    });
    const listModels = vi.fn(async () => []);
    const listProviders = vi.fn(async () => []);
    const get = vi.fn(async () => undefined);
    const reload = vi.fn(() => reloadResult);
    const port = createKlientRuntimeModelCatalogPort({
      global: {
        kosong: { listModels, listProviders },
        config: { reload, get },
      },
    });

    const loading = port.load({ reload: true });

    expect(reload).toHaveBeenCalledOnce();
    expect(listModels).not.toHaveBeenCalled();
    expect(listProviders).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();

    settleReload();
    await loading;

    expect(listModels).toHaveBeenCalledOnce();
    expect(listProviders).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledWith('providers');
  });

  it('returns the neutral empty snapshot when no runtime catalog is configured', async () => {
    const legacy = createLegacyRuntimeModelCatalogPort({
      getConfig: vi.fn(async () => ({ providers: {} })),
    });
    const klient = createKlientRuntimeModelCatalogPort(klientFacade());

    await expect(Promise.all([legacy.load(), klient.load()])).resolves.toEqual([
      {
        models: {},
        providers: {},
        defaultModel: undefined,
        thinking: undefined,
      },
      {
        models: {},
        providers: {},
        defaultModel: undefined,
        thinking: undefined,
      },
    ]);
  });
});

interface KlientFacadeOptions {
  readonly models?: readonly {
    readonly provider: string;
    readonly model: string;
    readonly display_name?: string;
    readonly max_context_size: number;
    readonly capabilities?: readonly string[];
    readonly support_efforts?: readonly string[];
    readonly default_effort?: string;
  }[];
  readonly providers?: readonly {
    readonly id: string;
    readonly type: string;
    readonly base_url?: string;
    readonly default_model?: string;
    readonly has_api_key: boolean;
    readonly status: 'connected' | 'error' | 'unconfigured';
  }[];
  readonly defaultModel?: string;
  readonly thinking?: {
    readonly enabled?: boolean;
    readonly effort?: string;
  };
  readonly providerConfigs?: unknown;
}

function klientFacade(options: KlientFacadeOptions = {}) {
  return {
    global: {
      kosong: {
        listModels: vi.fn(async () => options.models ?? []),
        listProviders: vi.fn(async () => options.providers ?? []),
      },
      config: {
        reload: vi.fn(async () => undefined),
        get: vi.fn(async (domain: string) => {
          if (domain === 'providers') return options.providerConfigs;
          if (domain === 'defaultModel') return options.defaultModel;
          if (domain === 'thinking') return options.thinking;
          throw new Error(`Unexpected config domain: ${domain}`);
        }),
      },
    },
  };
}
