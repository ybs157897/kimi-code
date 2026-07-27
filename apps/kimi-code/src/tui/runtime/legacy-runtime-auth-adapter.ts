import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import type {
  RuntimeAuthDeviceCode,
  RuntimeAuthPort,
} from './runtime-auth-port';
import { copyRuntimeManagedUsageResult } from './runtime-auth-port';

interface LegacyRuntimeAuthHarness {
  readonly auth: Pick<
    KimiHarness['auth'],
    | 'status'
    | 'login'
    | 'logout'
    | 'getManagedUsage'
    | 'submitFeedback'
    | 'createFeedbackUploadUrl'
    | 'completeFeedbackUpload'
  >;
}

type LegacyLoginOptions = NonNullable<
  Parameters<KimiHarness['auth']['login']>[1]
>;
type LegacyDeviceCode = Parameters<
  NonNullable<LegacyLoginOptions['onDeviceCode']>
>[0];

/** Bridge the current SDK harness authentication into the neutral TUI port. */
export function createLegacyRuntimeAuthPort(
  harness: LegacyRuntimeAuthHarness,
): RuntimeAuthPort {
  return {
    status: async (provider) => {
      const status = await harness.auth.status(provider);
      const providerStatus =
        provider === undefined
          ? status.providers[0]
          : status.providers.find((candidate) => candidate.providerName === provider);

      return {
        loggedIn: providerStatus?.hasToken ?? false,
        provider: providerStatus?.providerName ?? provider,
      };
    },
    login: async (provider, options = {}) => {
      await harness.auth.login(provider, {
        signal: options.signal,
        onDeviceCode:
          options.onDeviceCode === undefined
            ? undefined
            : (deviceCode) =>
                options.onDeviceCode?.(projectLegacyDeviceCode(deviceCode)),
      });
    },
    logout: async (provider) => {
      await harness.auth.logout(provider);
    },
    // The legacy prompt path owns its model/provider readiness gate. There is
    // no equivalent harness facade to call without duplicating that policy.
    ensureReady: async () => undefined,
    getManagedUsage: async (provider) =>
      copyRuntimeManagedUsageResult(
        await harness.auth.getManagedUsage(provider),
      ),
    submitFeedback: (input, provider) =>
      harness.auth.submitFeedback(
        {
          ...input,
          info: input.info === undefined ? undefined : { ...input.info },
        },
        provider,
      ),
    createFeedbackUploadUrl: (input, provider) =>
      harness.auth.createFeedbackUploadUrl(input, provider),
    completeFeedbackUpload: (input, provider) =>
      harness.auth.completeFeedbackUpload(input, provider),
  };
}

function projectLegacyDeviceCode(
  deviceCode: LegacyDeviceCode,
): RuntimeAuthDeviceCode {
  return {
    verificationUri: deviceCode.verificationUri,
    verificationUriComplete: deviceCode.verificationUriComplete,
    userCode: deviceCode.userCode,
    expiresIn: deviceCode.expiresIn,
    interval: deviceCode.interval,
  };
}
