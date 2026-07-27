import type {
  RuntimeConfigValue,
  RuntimeModelConfigApplyInput,
  RuntimeModelConfigPatch,
  RuntimeModelConfigPort,
  RuntimeProviderConfigPatch,
  RuntimeThinkingConfigPatch,
} from './runtime-model-config-port';

interface LegacyRuntimeModelConfigHarness {
  setConfig(input: RuntimeModelConfigApplyInput): Promise<unknown>;
  removeProvider(id: string): Promise<unknown>;
}

/** Bridge legacy harness config writes into the process-level neutral port. */
export function createLegacyRuntimeModelConfigPort(
  harness: LegacyRuntimeModelConfigHarness,
): RuntimeModelConfigPort {
  return {
    async apply(input) {
      await harness.setConfig(cloneApplyInput(input));
    },
    async removeProvider(id) {
      await harness.removeProvider(id);
    },
  };
}

function cloneApplyInput(
  input: RuntimeModelConfigApplyInput,
): RuntimeModelConfigApplyInput {
  return {
    providers:
      input.providers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(input.providers).map(([id, provider]) => [
              id,
              cloneProviderPatch(provider),
            ]),
          ),
    models:
      input.models === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(input.models).map(([id, model]) => [
              id,
              cloneModelPatch(model),
            ]),
          ),
    defaultModel: input.defaultModel,
    thinking: cloneThinkingPatch(input.thinking),
  };
}

function cloneProviderPatch(
  provider: RuntimeProviderConfigPatch,
): RuntimeProviderConfigPatch {
  return {
    ...provider,
    oauth: provider.oauth === undefined ? undefined : { ...provider.oauth },
    env: cloneStringRecord(provider.env),
    customHeaders: cloneStringRecord(provider.customHeaders),
    source:
      provider.source === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(provider.source).map(([key, value]) => [
              key,
              cloneConfigValue(value),
            ]),
          ),
  };
}

function cloneModelPatch(
  model: RuntimeModelConfigPatch,
): RuntimeModelConfigPatch {
  return {
    ...model,
    capabilities:
      model.capabilities === undefined ? undefined : [...model.capabilities],
    supportEfforts:
      model.supportEfforts === undefined ? undefined : [...model.supportEfforts],
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
  };
}

function cloneThinkingPatch(
  thinking: RuntimeThinkingConfigPatch | undefined,
): RuntimeThinkingConfigPatch | undefined {
  return thinking === undefined ? undefined : { ...thinking };
}

function cloneStringRecord(
  value: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  return value === undefined ? undefined : { ...value };
}

function cloneConfigValue(value: RuntimeConfigValue): RuntimeConfigValue {
  if (Array.isArray(value)) {
    return value.map((item) => cloneConfigValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneConfigValue(item),
      ]),
    );
  }
  return value;
}
