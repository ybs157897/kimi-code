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

type KlientRefreshProviders =
  KimiV2Runtime['klient']['global']['kosong']['refreshProviders'];

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

