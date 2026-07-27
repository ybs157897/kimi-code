import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { refreshAllProviderModels } from '../utils/refresh-providers';
import type { LegacyRuntimeProviderRefreshSource } from './legacy-runtime-provider-refresh-adapter';
import type { RuntimeProviderRefreshScope } from './runtime-provider-refresh-port';

/**
 * Compose the legacy harness capabilities required by provider discovery.
 * The source stays independent of AuthFlow so process-level runtime consumers
 * can refresh providers before any TUI controller exists.
 */
export function createLegacyRuntimeProviderRefreshSource(
  harness: KimiHarness,
  userAgent?: string,
): LegacyRuntimeProviderRefreshSource {
  const refresh = (scope: RuntimeProviderRefreshScope) =>
    refreshAllProviderModels(
      {
        getConfig: () => harness.getConfig({ reload: true }),
        removeProvider: (providerId) => harness.removeProvider(providerId),
        setConfig: (patch) => harness.setConfig(patch),
        resolveOAuthToken: async (providerName, oauthRef) => {
          const tokenProvider = harness.auth.resolveOAuthTokenProvider(
            providerName,
            oauthRef,
          );
          return tokenProvider.getAccessToken();
        },
        userAgent,
      },
      { scope },
    );

  return {
    refreshProviderModels: () => refresh('all'),
    refreshOAuthProviderModels: () => refresh('oauth'),
  };
}
