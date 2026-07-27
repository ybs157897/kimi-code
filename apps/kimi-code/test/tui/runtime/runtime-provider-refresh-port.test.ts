/**
 * Scenario: provider discovery crosses the process-level TUI runtime boundary.
 * Responsibilities: legacy scope routing and Klient wire projection both
 * return owned neutral snapshots and propagate call-level failures. Each
 * provider-discovery facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/runtime-provider-refresh-port.test.ts
 */

import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';
import { describe, expect, it, vi } from 'vitest';

import {
  createKlientRuntimeProviderRefreshPort,
} from '#/tui/runtime/klient-runtime-provider-refresh-adapter';
import {
  createLegacyRuntimeProviderRefreshPort,
  type LegacyRuntimeProviderRefreshSource,
} from '#/tui/runtime/legacy-runtime-provider-refresh-adapter';

type KlientRefreshProviders =
  KimiV2Runtime['klient']['global']['kosong']['refreshProviders'];

describe('legacy provider refresh adapter (scope routing)', () => {
  it('routes all scope to the general legacy discovery source', async () => {
    const { port, source } = legacyRig();

    await port.refresh('all');

    expect(source.refreshProviderModels).toHaveBeenCalledOnce();
    expect(source.refreshOAuthProviderModels).not.toHaveBeenCalled();
  });

  it('routes oauth scope only to the legacy OAuth discovery source', async () => {
    const { port, source } = legacyRig();

    await port.refresh('oauth');

    expect(source.refreshOAuthProviderModels).toHaveBeenCalledOnce();
    expect(source.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('returns an owned neutral snapshot when legacy discovery succeeds', async () => {
    const sourceResult = {
      changed: [
        {
          providerId: 'provider-example',
          providerName: 'Example provider',
          added: 2,
          removed: 1,
        },
      ],
      unchanged: ['provider-stable'],
      failed: [
        {
          provider: 'provider-failed',
          reason: 'Example discovery failure',
        },
      ],
    };
    const { port } = legacyRig({
      refreshProviderModels: vi.fn(async () => sourceResult),
    });

    const result = await port.refresh('all');
    sourceResult.changed[0]!.providerName = 'Mutated provider';
    sourceResult.unchanged[0] = 'provider-mutated';
    sourceResult.failed[0]!.reason = 'Mutated failure';

    expect(result).toEqual({
      changed: [
        {
          providerId: 'provider-example',
          providerName: 'Example provider',
          added: 2,
          removed: 1,
        },
      ],
      unchanged: ['provider-stable'],
      failed: [
        {
          provider: 'provider-failed',
          reason: 'Example discovery failure',
        },
      ],
    });
  });

  it('propagates the source error when legacy discovery rejects', async () => {
    const sourceError = new Error('Legacy discovery unavailable');
    const { port } = legacyRig({
      refreshProviderModels: vi.fn(async () => {
        throw sourceError;
      }),
    });

    await expect(port.refresh('all')).rejects.toBe(sourceError);
  });
});

describe('Klient provider refresh adapter (wire projection)', () => {
  it.each(['all', 'oauth'] as const)(
    'passes the %s scope to Klient provider discovery',
    async (scope) => {
      const { port, refreshProviders } = klientRig();

      await port.refresh(scope);

      expect(refreshProviders).toHaveBeenCalledWith({ scope });
    },
  );

  it('returns an owned neutral snapshot when Klient discovery succeeds', async () => {
    const klientResult = {
      changed: [
        {
          provider_id: 'provider-example',
          provider_name: 'Example provider',
          added: 3,
          removed: 2,
        },
      ],
      unchanged: ['provider-stable'],
      failed: [
        {
          provider: 'provider-failed',
          reason: 'Example discovery failure',
        },
      ],
    };
    const { port } = klientRig(vi.fn(async () => klientResult));

    const result = await port.refresh('all');
    klientResult.changed[0]!.provider_name = 'Mutated provider';
    klientResult.unchanged[0] = 'provider-mutated';
    klientResult.failed[0]!.reason = 'Mutated failure';

    expect(result).toEqual({
      changed: [
        {
          providerId: 'provider-example',
          providerName: 'Example provider',
          added: 3,
          removed: 2,
        },
      ],
      unchanged: ['provider-stable'],
      failed: [
        {
          provider: 'provider-failed',
          reason: 'Example discovery failure',
        },
      ],
    });
  });

  it('propagates the facade error when Klient discovery rejects', async () => {
    const facadeError = new Error('Klient discovery unavailable');
    const refreshProviders = vi.fn<KlientRefreshProviders>(async () => {
      throw facadeError;
    });
    const { port } = klientRig(refreshProviders);

    await expect(port.refresh('oauth')).rejects.toBe(facadeError);
  });
});

function legacyRig(
  overrides: Partial<LegacyRuntimeProviderRefreshSource> = {},
) {
  const source: LegacyRuntimeProviderRefreshSource = {
    refreshProviderModels: vi.fn(async () => emptyRefreshResult()),
    refreshOAuthProviderModels: vi.fn(async () => emptyRefreshResult()),
    ...overrides,
  };
  return {
    port: createLegacyRuntimeProviderRefreshPort(source),
    source,
  };
}

function klientRig(
  refreshProviders: KlientRefreshProviders = vi.fn(async () => ({
    changed: [],
    unchanged: [],
    failed: [],
  })),
) {
  const klient = {
    global: {
      kosong: { refreshProviders },
    },
  } as unknown as KimiV2Runtime['klient'];
  return {
    port: createKlientRuntimeProviderRefreshPort(klient),
    refreshProviders,
  };
}

function emptyRefreshResult() {
  return {
    changed: [],
    unchanged: [],
    failed: [],
  };
}
