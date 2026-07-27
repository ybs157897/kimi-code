export type RuntimeProviderRefreshScope = 'all' | 'oauth';

export interface RuntimeProviderRefreshChange {
  readonly providerId: string;
  readonly providerName: string;
  readonly added: number;
  readonly removed: number;
}

export interface RuntimeProviderRefreshFailure {
  readonly provider: string;
  readonly reason: string;
}

export interface RuntimeProviderRefreshResult {
  readonly changed: readonly RuntimeProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly RuntimeProviderRefreshFailure[];
}

/** Process-level provider discovery used by the interactive TUI. */
export interface RuntimeProviderRefreshPort {
  refresh(
    scope: RuntimeProviderRefreshScope,
  ): Promise<RuntimeProviderRefreshResult>;
}
