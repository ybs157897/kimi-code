import type {
  RuntimeModelCatalogModel,
  RuntimeModelCatalogModelOverrides,
} from './runtime-model-catalog-port';

export type { RuntimeProviderConfigView } from './runtime-model-catalog-port';

export type RuntimeProviderType =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'google-genai'
  | 'openai_responses'
  | 'vertexai';

export type RuntimeConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeConfigValue[]
  | { readonly [key: string]: RuntimeConfigValue };

export interface RuntimeOAuthReference {
  readonly storage: 'file' | 'keyring';
  readonly key: string;
  readonly oauthHost?: string;
}

/** Runtime-neutral patch for one persisted provider entry. */
export interface RuntimeProviderConfigPatch {
  readonly type?: RuntimeProviderType;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly oauth?: RuntimeOAuthReference;
  readonly env?: Readonly<Record<string, string>>;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly source?: Readonly<Record<string, RuntimeConfigValue>>;
}

/** Runtime-neutral patch for one persisted model entry. */
export interface RuntimeModelConfigPatch
  extends Partial<Omit<RuntimeModelCatalogModel, 'overrides'>> {
  readonly overrides?: RuntimeModelCatalogModelOverrides;
}

/** Runtime-neutral patch for the persisted thinking defaults. */
export interface RuntimeThinkingConfigPatch {
  readonly enabled?: boolean;
  readonly effort?: string;
  readonly keep?: string;
}

export interface RuntimeModelConfigApplyInput {
  readonly providers?: Readonly<Record<string, RuntimeProviderConfigPatch>>;
  readonly models?: Readonly<Record<string, RuntimeModelConfigPatch>>;
  readonly defaultModel?: string;
  readonly thinking?: RuntimeThinkingConfigPatch;
}

/** Process-level writes for model/provider configuration. */
export interface RuntimeModelConfigPort {
  apply(input: RuntimeModelConfigApplyInput): Promise<void>;
  removeProvider(id: string): Promise<void>;
}
