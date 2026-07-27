import type {
  RuntimeFeatureFlagsPort,
  RuntimeFeatureState,
} from './runtime-feature-flags-port';

interface LegacyFeatureState {
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

interface LegacyRuntimeFeatureFlagsHarness {
  getExperimentalFeatures(): Promise<readonly LegacyFeatureState[]>;
  setConfig(input: {
    readonly experimental: Readonly<Record<string, boolean>>;
  }): Promise<unknown>;
}

/** Bridge legacy harness feature flags into the process-level neutral port. */
export function createLegacyRuntimeFeatureFlagsPort(
  harness: LegacyRuntimeFeatureFlagsHarness,
): RuntimeFeatureFlagsPort {
  const list = async (): Promise<readonly RuntimeFeatureState[]> =>
    projectFeatures(await harness.getExperimentalFeatures());

  return {
    list,
    async apply(changes) {
      await harness.setConfig({ experimental: { ...changes } });
      return list();
    },
  };
}

function projectFeatures(
  features: readonly LegacyFeatureState[],
): RuntimeFeatureState[] {
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
