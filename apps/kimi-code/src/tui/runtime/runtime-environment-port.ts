/** Runtime-neutral experimental flag identifier crossing the TUI runtime boundary. */
export type FlagId = string;

/** Wire-friendly experimental feature snapshot used by the interactive TUI. */
export interface RuntimeExperimentalFeatureState {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly surface: 'core' | 'tui' | 'both';
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly source: 'master-env' | 'env' | 'config' | 'default';
  readonly configValue?: boolean;
}

/** Process-level runtime capabilities used by the interactive TUI. */
export interface RuntimeEnvironmentPort {
  readonly homeDir: string;
  getExperimentalFeatures(): Promise<readonly RuntimeExperimentalFeatureState[]>;
  getConfigDiagnostics(): Promise<readonly string[]>;
  close(): Promise<void>;
}
