import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import type {
  RuntimeEnvironmentPort,
  RuntimeExperimentalFeatureState,
} from './runtime-environment-port';

interface LegacyRuntimeEnvironmentHarness {
  readonly homeDir: KimiHarness['homeDir'];
  getExperimentalFeatures(): ReturnType<KimiHarness['getExperimentalFeatures']>;
  getConfigDiagnostics(): ReturnType<KimiHarness['getConfigDiagnostics']>;
  close(): ReturnType<KimiHarness['close']>;
}

/** Bridge the current SDK harness into the process-level TUI runtime port. */
export function createLegacyRuntimeEnvironmentPort(
  harness: LegacyRuntimeEnvironmentHarness,
): RuntimeEnvironmentPort {
  return {
    homeDir: harness.homeDir,
    getExperimentalFeatures: async () =>
      projectExperimentalFeatures(await harness.getExperimentalFeatures()),
    getConfigDiagnostics: async () => (await harness.getConfigDiagnostics()).warnings,
    close: () => harness.close(),
  };
}

function projectExperimentalFeatures(
  features: Awaited<ReturnType<KimiHarness['getExperimentalFeatures']>>,
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
