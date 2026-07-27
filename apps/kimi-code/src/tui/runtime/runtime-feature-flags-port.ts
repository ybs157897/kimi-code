/** Runtime-neutral experimental feature state used by the interactive TUI. */
export interface RuntimeFeatureState {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly surface: 'core' | 'tui' | 'both';
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly source: 'master-env' | 'env' | 'config' | 'default';
  readonly configValue?: boolean;
}

/** Process-level experimental feature reads and persistent overrides. */
export interface RuntimeFeatureFlagsPort {
  list(): Promise<readonly RuntimeFeatureState[]>;
  apply(
    changes: Readonly<Record<string, boolean>>,
  ): Promise<readonly RuntimeFeatureState[]>;
}
