import type {
  RuntimeModelCatalogPort,
  RuntimeModelCatalogSnapshot,
  RuntimeModelCatalogThinking,
  RuntimeProviderConfigValue,
} from './runtime-model-catalog-port';

interface KlientModelCatalogItem {
  readonly provider: string;
  readonly model: string;
  readonly display_name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

interface KlientProviderCatalogItem {
  readonly id: string;
  readonly type: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly status: 'connected' | 'error' | 'unconfigured';
  readonly has_api_key: boolean;
}

interface KlientRuntimeModelCatalogFacade {
  readonly global: {
    readonly kosong: {
      listModels(): Promise<readonly KlientModelCatalogItem[]>;
      listProviders(): Promise<readonly KlientProviderCatalogItem[]>;
    };
    readonly config: {
      reload(): Promise<void>;
      get(domain: string): Promise<unknown>;
    };
  };
}

interface KlientRuntimeModelCatalogOwner {
  readonly klient: KlientRuntimeModelCatalogFacade;
}

/** Project the Klient catalog and global selection into the neutral TUI port. */
export function createKlientRuntimeModelCatalogPort(
  runtime: KlientRuntimeModelCatalogFacade | KlientRuntimeModelCatalogOwner,
): RuntimeModelCatalogPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;

  return {
    async load(options = {}) {
      if (options.reload === true) {
        await klient.global.config.reload();
      }

      const [models, providers, providerConfigs, defaultModel, thinking] = await Promise.all([
        klient.global.kosong.listModels(),
        klient.global.kosong.listProviders(),
        klient.global.config.get('providers'),
        klient.global.config.get('defaultModel'),
        klient.global.config.get('thinking'),
      ]);

      return projectKlientCatalog(
        models,
        providers,
        providerConfigs,
        optionalString(defaultModel),
        projectThinking(thinking),
      );
    },
  };
}

function projectKlientCatalog(
  models: readonly KlientModelCatalogItem[],
  providers: readonly KlientProviderCatalogItem[],
  providerConfigsValue: unknown,
  defaultModel: string | undefined,
  thinking: RuntimeModelCatalogThinking | undefined,
): RuntimeModelCatalogSnapshot {
  const providerConfigs = isRecord(providerConfigsValue)
    ? providerConfigsValue
    : {};
  return {
    models: Object.fromEntries(
      models.map((model) => [
        model.model,
        {
          provider: model.provider,
          model: model.model,
          maxContextSize: model.max_context_size,
          capabilities:
            model.capabilities === undefined
              ? undefined
              : [...model.capabilities],
          displayName: model.display_name,
          supportEfforts:
            model.support_efforts === undefined
              ? undefined
              : [...model.support_efforts],
          defaultEffort: model.default_effort,
        },
      ]),
    ),
    providers: Object.fromEntries(
      providers.map((provider) => {
        const config = providerConfigs[provider.id];
        const configRecord = isRecord(config) ? config : undefined;
        return [
          provider.id,
          {
            type: provider.type,
            baseUrl: provider.base_url,
            defaultModel: provider.default_model,
            status: provider.status,
            hasApiKey: provider.has_api_key,
            env: cloneStringRecord(configRecord?.['env']),
            customHeaders: cloneStringRecord(configRecord?.['customHeaders']),
            source: cloneConfigRecord(configRecord?.['source']),
          },
        ];
      }),
    ),
    defaultModel,
    thinking,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function projectThinking(
  value: unknown,
): RuntimeModelCatalogThinking | undefined {
  if (!isRecord(value)) return undefined;
  return {
    enabled:
      typeof value['enabled'] === 'boolean' ? value['enabled'] : undefined,
    effort: optionalString(value['effort']),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const copy: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') copy[key] = item;
  }
  return copy;
}

function cloneConfigRecord(
  value: unknown,
): Record<string, RuntimeProviderConfigValue> | undefined {
  if (!isRecord(value)) return undefined;
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
  return cloneConfigRecord(value);
}
