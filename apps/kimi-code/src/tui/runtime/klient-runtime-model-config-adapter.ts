import type {
  RuntimeModelConfigApplyInput,
  RuntimeModelConfigPort,
} from './runtime-model-config-port';

interface KlientRuntimeModelConfigFacade {
  readonly global: {
    readonly config: {
      set(input: {
        domain: string;
        patch: unknown;
        target?: 'user' | 'memory';
      }): Promise<void>;
      replace(input: {
        domain: string;
        value: unknown;
        target?: 'user' | 'memory';
      }): Promise<void>;
    };
    readonly kosong: {
      removeProvider(id: string): Promise<void>;
    };
  };
}

interface KlientRuntimeModelConfigOwner {
  readonly klient: KlientRuntimeModelConfigFacade;
}

/** Persist model configuration and provider discovery through Klient. */
export function createKlientRuntimeModelConfigPort(
  runtime: KlientRuntimeModelConfigFacade | KlientRuntimeModelConfigOwner,
): RuntimeModelConfigPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;

  return {
    async apply(input) {
      const patch = structuredClone(input);
      await persistPatch(klient, patch);
    },
    removeProvider: (id) => klient.global.kosong.removeProvider(id),
  };
}

async function persistPatch(
  klient: KlientRuntimeModelConfigFacade,
  patch: RuntimeModelConfigApplyInput,
): Promise<void> {
  if (patch.providers !== undefined) {
    await klient.global.config.set({
      domain: 'providers',
      patch: patch.providers,
      target: 'user',
    });
  }
  if (patch.models !== undefined) {
    await klient.global.config.set({
      domain: 'models',
      patch: patch.models,
      target: 'user',
    });
  }
  if (patch.defaultModel !== undefined) {
    await klient.global.config.replace({
      domain: 'defaultModel',
      value: patch.defaultModel,
      target: 'user',
    });
  }
  if (patch.thinking !== undefined) {
    await klient.global.config.set({
      domain: 'thinking',
      patch: patch.thinking,
      target: 'user',
    });
  }
}
