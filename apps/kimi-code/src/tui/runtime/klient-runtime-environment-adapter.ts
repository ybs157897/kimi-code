import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  RuntimeEnvironmentPort,
  RuntimeExperimentalFeatureState,
} from './runtime-environment-port';

/**
 * Bridge the v2 process runtime into the same TUI environment contract.
 *
 * Creation is asynchronous because Klient exposes the runtime home through
 * its aggregated environment snapshot rather than as a local property.
 */
export async function createKlientRuntimeEnvironmentPort(
  runtime: KimiV2Runtime,
): Promise<RuntimeEnvironmentPort> {
  const { homeDir } = await runtime.klient.global.env();

  return {
    homeDir,
    getExperimentalFeatures: async () =>
      projectExperimentalFeatures(await runtime.klient.global.flags.list()),
    getConfigDiagnostics: async () =>
      (await runtime.klient.global.config.diagnostics())
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => diagnostic.message),
    close: () => runtime.close(),
  };
}

function projectExperimentalFeatures(
  features: Awaited<ReturnType<KimiV2Runtime['klient']['global']['flags']['list']>>,
): RuntimeExperimentalFeatureState[] {
  return features.map((feature) => ({
    id: feature.id,
    title: feature.title,
    description: feature.description,
    surface: feature.surface,
    env: feature.env,
    defaultEnabled: feature.defaultEnabled,
    enabled: feature.enabled,
    source: feature.source,
    configValue: feature.configValue,
  }));
}
