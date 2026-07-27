import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  RuntimeProviderRefreshPort,
  RuntimeProviderRefreshResult,
} from './runtime-provider-refresh-port';

type Klient = KimiV2Runtime['klient'];
type KlientRefreshResult = Awaited<
  ReturnType<Klient['global']['kosong']['refreshProviders']>
>;

/** Bridge Klient provider discovery into the runtime-neutral TUI port. */
export function createKlientRuntimeProviderRefreshPort(
  runtime: KimiV2Runtime | Klient,
): RuntimeProviderRefreshPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;

  return {
    refresh: async (scope) =>
      projectKlientRefreshResult(
        await klient.global.kosong.refreshProviders({ scope }),
      ),
  };
}

function projectKlientRefreshResult(
  result: KlientRefreshResult,
): RuntimeProviderRefreshResult {
  return {
    changed: result.changed.map((change) => ({
      providerId: change.provider_id,
      providerName: change.provider_name,
      added: change.added,
      removed: change.removed,
    })),
    unchanged: [...result.unchanged],
    failed: result.failed.map((failure) => ({
      provider: failure.provider,
      reason: failure.reason,
    })),
  };
}
