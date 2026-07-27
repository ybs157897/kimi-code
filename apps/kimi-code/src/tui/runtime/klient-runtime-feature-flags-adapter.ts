import type {
  RuntimeFeatureFlagsPort,
  RuntimeFeatureState,
} from './runtime-feature-flags-port';

interface KlientFeatureState {
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

interface KlientRuntimeFeatureFlagsFacade {
  readonly global: {
    readonly flags: {
      list(): Promise<readonly KlientFeatureState[]>;
    };
    readonly config: {
      set(input: {
        domain: string;
        patch: unknown;
        target?: 'user' | 'memory';
      }): Promise<void>;
    };
  };
}

interface KlientRuntimeFeatureFlagsOwner {
  readonly klient: KlientRuntimeFeatureFlagsFacade;
}

/** Persist feature overrides through Klient and return the refreshed snapshot. */
export function createKlientRuntimeFeatureFlagsPort(
  runtime:
    | KlientRuntimeFeatureFlagsFacade
    | KlientRuntimeFeatureFlagsOwner,
): RuntimeFeatureFlagsPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;
  const list = async (): Promise<readonly RuntimeFeatureState[]> =>
    projectFeatures(await klient.global.flags.list());

  return {
    list,
    async apply(changes) {
      await klient.global.config.set({
        domain: 'experimental',
        patch: { ...changes },
        target: 'user',
      });
      return list();
    },
  };
}

function projectFeatures(
  features: readonly KlientFeatureState[],
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
