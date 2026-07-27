/**
 * Scenario: process-level model configuration crosses the TUI runtime boundary.
 * Responsibilities: both adapters persist neutral patches, remove providers,
 * and copy caller-owned data. The legacy harness and Klient facade are the
 * only stubbed boundaries.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-model-config-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientRuntimeModelConfigPort } from '#/tui/runtime/klient-runtime-model-config-adapter';
import { createLegacyRuntimeModelConfigPort } from '#/tui/runtime/legacy-runtime-model-config-adapter';
import type { RuntimeModelConfigApplyInput } from '#/tui/runtime/runtime-model-config-port';

describe('legacy runtime model config adapter', () => {
  it('copies every neutral config field into the legacy config patch', async () => {
    const setConfig = vi.fn(
      async (_input: RuntimeModelConfigApplyInput): Promise<void> => undefined,
    );
    const port = createLegacyRuntimeModelConfigPort({
      setConfig,
      removeProvider: vi.fn(async () => undefined),
    });
    const input = modelConfigPatch();

    await port.apply(input);

    expect(setConfig).toHaveBeenCalledWith(input);
    const persisted = setConfig.mock.calls[0]?.[0];
    expect(persisted).not.toBe(input);
    expect(persisted?.providers).not.toBe(input.providers);
    expect(persisted?.providers?.['example']?.oauth).not.toBe(
      input.providers?.['example']?.oauth,
    );
    expect(persisted?.providers?.['example']?.env).not.toBe(
      input.providers?.['example']?.env,
    );
    expect(persisted?.providers?.['example']?.customHeaders).not.toBe(
      input.providers?.['example']?.customHeaders,
    );
    expect(persisted?.providers?.['example']?.source).not.toBe(
      input.providers?.['example']?.source,
    );
    expect(persisted?.models).not.toBe(input.models);
    expect(persisted?.models?.['example/model']?.capabilities).not.toBe(
      input.models?.['example/model']?.capabilities,
    );
    expect(persisted?.models?.['example/model']?.supportEfforts).not.toBe(
      input.models?.['example/model']?.supportEfforts,
    );
    expect(persisted?.models?.['example/model']?.overrides).not.toBe(
      input.models?.['example/model']?.overrides,
    );
    expect(persisted?.thinking).not.toBe(input.thinking);
  });

  it('removes a provider through the legacy harness', async () => {
    const removeProvider = vi.fn(async () => ({ providers: {} }));
    const port = createLegacyRuntimeModelConfigPort({
      setConfig: vi.fn(async () => undefined),
      removeProvider,
    });

    await port.removeProvider('example');

    expect(removeProvider).toHaveBeenCalledExactlyOnceWith('example');
  });

});

describe('Klient runtime model config adapter', () => {
  it('copies every neutral field into its explicit persistent config domain', async () => {
    const set = vi.fn(
      async (_input: {
        domain: string;
        patch: unknown;
        target?: 'user' | 'memory';
      }): Promise<void> => undefined,
    );
    const replace = vi.fn(
      async (_input: {
        domain: string;
        value: unknown;
        target?: 'user' | 'memory';
      }): Promise<void> => undefined,
    );
    const port = createKlientRuntimeModelConfigPort(
      klientFacade({ set, replace }),
    );
    const input = modelConfigPatch();

    await port.apply(input);

    expect(set).toHaveBeenNthCalledWith(1, {
      domain: 'providers',
      patch: input.providers,
      target: 'user',
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      domain: 'models',
      patch: input.models,
      target: 'user',
    });
    expect(replace).toHaveBeenCalledExactlyOnceWith({
      domain: 'defaultModel',
      value: 'example/model',
      target: 'user',
    });
    expect(set).toHaveBeenNthCalledWith(3, {
      domain: 'thinking',
      patch: input.thinking,
      target: 'user',
    });
    expect(set.mock.calls[0]?.[0].patch).not.toBe(input.providers);
    expect(set.mock.calls[1]?.[0].patch).not.toBe(input.models);
    expect(set.mock.calls[2]?.[0].patch).not.toBe(input.thinking);
  });

  it('removes a provider through Klient kosong', async () => {
    const removeProvider = vi.fn(async () => undefined);
    const port = createKlientRuntimeModelConfigPort(
      klientFacade({ removeProvider }),
    );

    await port.removeProvider('example');

    expect(removeProvider).toHaveBeenCalledExactlyOnceWith('example');
  });

});

function modelConfigPatch(): RuntimeModelConfigApplyInput {
  return {
    providers: {
      example: {
        type: 'openai',
        apiKey: 'YOUR_API_KEY',
        baseUrl: 'https://api.example.test',
        defaultModel: 'example/model',
        oauth: {
          storage: 'keyring',
          key: 'example-oauth',
          oauthHost: 'https://oauth.example.test',
        },
        env: { EXAMPLE_API_KEY: 'YOUR_API_KEY' },
        customHeaders: { 'X-Example': 'header-value' },
        source: {
          kind: 'apiJson',
          url: 'https://catalog.example.test/api.json',
          options: ['stable', { retries: 2 }],
        },
      },
    },
    models: {
      'example/model': {
        provider: 'example',
        model: 'model',
        maxContextSize: 128_000,
        maxInputSize: 120_000,
        maxOutputSize: 8_000,
        capabilities: ['thinking', 'tool_use'],
        displayName: 'Example Model',
        reasoningKey: 'reasoning_effort',
        protocol: 'anthropic',
        adaptiveThinking: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'low',
        offEffort: 'none',
        betaApi: true,
        baseUrl: 'https://model.example.test',
        overrides: {
          maxContextSize: 64_000,
          maxInputSize: 60_000,
          maxOutputSize: 4_000,
          capabilities: ['thinking'],
          displayName: 'Example Model Override',
          reasoningKey: 'effort',
          adaptiveThinking: false,
          supportEfforts: ['medium'],
          defaultEffort: 'medium',
          offEffort: 'off',
        },
      },
    },
    defaultModel: 'example/model',
    thinking: { enabled: true, effort: 'high', keep: 'all' },
  };
}

interface KlientFacadeOverrides {
  readonly set?: (
    input: {
      domain: string;
      patch: unknown;
      target?: 'user' | 'memory';
    },
  ) => Promise<void>;
  readonly replace?: (
    input: {
      domain: string;
      value: unknown;
      target?: 'user' | 'memory';
    },
  ) => Promise<void>;
  readonly removeProvider?: (id: string) => Promise<void>;
}

function klientFacade(overrides: KlientFacadeOverrides = {}) {
  return {
    global: {
      config: {
        set: overrides.set ?? vi.fn(async () => undefined),
        replace: overrides.replace ?? vi.fn(async () => undefined),
      },
      kosong: {
        removeProvider: overrides.removeProvider ?? vi.fn(async () => undefined),
      },
    },
  };
}
