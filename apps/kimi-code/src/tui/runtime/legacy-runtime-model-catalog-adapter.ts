import type {
  RuntimeModelCatalogLoadOptions,
  RuntimeModelCatalogModel,
  RuntimeModelCatalogPort,
  RuntimeModelCatalogProviderStatus,
  RuntimeModelCatalogSnapshot,
  RuntimeModelCatalogThinking,
  RuntimeProviderConfigValue,
} from './runtime-model-catalog-port';

interface LegacyProviderConfig {
  readonly type: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly source?: Readonly<Record<string, unknown>>;
}

interface LegacyModelCatalogConfig {
  readonly models?: Readonly<Record<string, RuntimeModelCatalogModel>>;
  readonly providers: Readonly<Record<string, LegacyProviderConfig>>;
  readonly defaultModel?: string;
  readonly thinking?: RuntimeModelCatalogThinking;
}

interface LegacyRuntimeModelCatalogHarness {
  getConfig(
    options?: RuntimeModelCatalogLoadOptions,
  ): Promise<LegacyModelCatalogConfig>;
}

/** Project the legacy harness config into the runtime-neutral TUI catalog. */
export function createLegacyRuntimeModelCatalogPort(
  harness: LegacyRuntimeModelCatalogHarness,
): RuntimeModelCatalogPort {
  return {
    async load(options = {}) {
      const config = await harness.getConfig(options);
      return projectLegacyConfig(config);
    },
  };
}

function projectLegacyConfig(
  config: LegacyModelCatalogConfig,
): RuntimeModelCatalogSnapshot {
  const models = Object.fromEntries(
    Object.entries(config.models ?? {}).map(([alias, model]) => [
      alias,
      {
        ...model,
        capabilities:
          model.capabilities === undefined
            ? undefined
            : [...model.capabilities],
        supportEfforts:
          model.supportEfforts === undefined
            ? undefined
            : [...model.supportEfforts],
        overrides:
          model.overrides === undefined
            ? undefined
            : {
                ...model.overrides,
                capabilities:
                  model.overrides.capabilities === undefined
                    ? undefined
                    : [...model.overrides.capabilities],
                supportEfforts:
                  model.overrides.supportEfforts === undefined
                    ? undefined
                    : [...model.overrides.supportEfforts],
              },
      },
    ]),
  );
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([id, provider]) => {
      const hasApiKey =
        provider.apiKey !== undefined && provider.apiKey.trim().length > 0;
      const status: RuntimeModelCatalogProviderStatus = hasApiKey
        ? 'connected'
        : 'unconfigured';
      return [
        id,
        {
          type: provider.type,
          baseUrl: provider.baseUrl,
          defaultModel: provider.defaultModel,
          status,
          hasApiKey,
          env: cloneStringRecord(provider.env),
          customHeaders: cloneStringRecord(provider.customHeaders),
          source: cloneConfigRecord(provider.source),
        },
      ];
    }),
  );

  return {
    models,
    providers,
    defaultModel: config.defaultModel,
    thinking:
      config.thinking === undefined
        ? undefined
        : {
            enabled: config.thinking.enabled,
            effort: config.thinking.effort,
          },
  };
}

function cloneStringRecord(
  value: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  return value === undefined ? undefined : { ...value };
}

function cloneConfigRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, RuntimeProviderConfigValue> | undefined {
  if (value === undefined) return undefined;
  const copy: Record<string, RuntimeProviderConfigValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const cloned = cloneConfigValue(item);
    if (cloned !== undefined) copy[key] = cloned;
  }
  return copy;
}

function cloneConfigValue(
  value: unknown,
): RuntimeProviderConfigValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const copy: RuntimeProviderConfigValue[] = [];
    for (const item of value) {
      const cloned = cloneConfigValue(item);
      if (cloned !== undefined) copy.push(cloned);
    }
    return copy;
  }
  if (isRecord(value)) return cloneConfigRecord(value);
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
