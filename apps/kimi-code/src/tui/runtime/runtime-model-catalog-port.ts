export type RuntimeModelCatalogProviderStatus =
  | 'connected'
  | 'error'
  | 'unconfigured';

export type RuntimeProviderConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeProviderConfigValue[]
  | { readonly [key: string]: RuntimeProviderConfigValue };

export interface RuntimeModelCatalogModelOverrides {
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: string[];
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
}

export interface RuntimeModelCatalogModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: string[];
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly protocol?: 'anthropic';
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly betaApi?: boolean;
  readonly baseUrl?: string;
  readonly overrides?: RuntimeModelCatalogModelOverrides;
}

/**
 * Resolve the runtime model fields consumed by presentation. Catalog records
 * preserve user overrides separately, so TUI components apply that shallow
 * overlay without importing engine config helpers.
 */
export function effectiveRuntimeModelCatalogModel(
  model: RuntimeModelCatalogModel,
): RuntimeModelCatalogModel {
  const { overrides, ...base } = model;
  if (overrides === undefined) return model;

  const effective = { ...base, ...overrides };
  if (
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }
  return effective;
}

/** Runtime-neutral provider read model, including safe configuration provenance. */
export interface RuntimeProviderConfigView {
  readonly type?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly status?: RuntimeModelCatalogProviderStatus;
  readonly hasApiKey?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly source?: Readonly<Record<string, unknown>>;
}

export interface RuntimeModelCatalogProvider
  extends RuntimeProviderConfigView {
  readonly type: string;
  readonly status: RuntimeModelCatalogProviderStatus;
  readonly hasApiKey: boolean;
  readonly source?: Readonly<Record<string, RuntimeProviderConfigValue>>;
}

export interface RuntimeModelCatalogThinking {
  readonly enabled?: boolean;
  readonly effort?: string;
}

export interface RuntimeModelCatalogSnapshot {
  readonly models: Record<string, RuntimeModelCatalogModel>;
  readonly providers: Record<string, RuntimeModelCatalogProvider>;
  readonly defaultModel?: string;
  readonly thinking?: RuntimeModelCatalogThinking;
}

export interface RuntimeModelCatalogLoadOptions {
  readonly reload?: boolean;
}

/** Process-level, read-only model and provider catalog used by the TUI. */
export interface RuntimeModelCatalogPort {
  load(
    options?: RuntimeModelCatalogLoadOptions,
  ): Promise<RuntimeModelCatalogSnapshot>;
}
