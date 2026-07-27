import type {
  RuntimeProviderRefreshPort,
  RuntimeProviderRefreshResult,
} from './runtime-provider-refresh-port';

/** Narrow legacy discovery source supplied by the process composition root. */
export interface LegacyRuntimeProviderRefreshSource {
  refreshProviderModels(): Promise<RuntimeProviderRefreshResult>;
  refreshOAuthProviderModels(): Promise<RuntimeProviderRefreshResult>;
}

/** Bridge legacy provider discovery into the runtime-neutral TUI port. */
export function createLegacyRuntimeProviderRefreshPort(
  source: LegacyRuntimeProviderRefreshSource,
): RuntimeProviderRefreshPort {
  return {
    async refresh(scope) {
      switch (scope) {
        case 'all':
          return copyRefreshResult(await source.refreshProviderModels());
        case 'oauth':
          return copyRefreshResult(await source.refreshOAuthProviderModels());
      }
    },
  };
}

function copyRefreshResult(
  result: RuntimeProviderRefreshResult,
): RuntimeProviderRefreshResult {
  return {
    changed: result.changed.map((change) => ({
      providerId: change.providerId,
      providerName: change.providerName,
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
