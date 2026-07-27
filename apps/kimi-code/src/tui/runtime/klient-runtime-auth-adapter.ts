import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  RuntimeAuthDeviceCode,
  RuntimeAuthLoginOptions,
  RuntimeAuthPort,
} from './runtime-auth-port';
import { copyRuntimeManagedUsageResult } from './runtime-auth-port';

type Klient = KimiV2Runtime['klient'];
type KlientAuth = Klient['global']['auth'];
type KlientFlowStart = Awaited<ReturnType<KlientAuth['startLogin']>>;
type KlientPendingFlow = Extract<KlientFlowStart, { readonly status: 'pending' }>;
type KlientFlowSnapshot = NonNullable<
  Awaited<ReturnType<KlientAuth['flow']>>
>;

/** Bridge the v2 Klient authentication flow into the neutral TUI port. */
export function createKlientRuntimeAuthPort(
  runtime: KimiV2Runtime | Klient,
): RuntimeAuthPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;
  const auth = klient.global.auth;

  return {
    status: async (provider) => {
      const status = await auth.status(provider);
      return {
        loggedIn: status.loggedIn,
        provider: status.provider,
      };
    },
    login: (provider, options = {}) =>
      runKlientLogin(auth, provider, options),
    logout: async (provider) => {
      await auth.logout(provider);
    },
    ensureReady: (model) => auth.ensureReady(model),
    getManagedUsage: async (provider) =>
      copyRuntimeManagedUsageResult(await auth.getManagedUsage(provider)),
    submitFeedback: (input, provider) =>
      auth.submitFeedback(
        {
          session_id: input.sessionId,
          content: input.content,
          version: input.version,
          os: input.os,
          model: input.model,
          contact: input.contact,
          info: input.info === undefined ? undefined : { ...input.info },
        },
        provider,
      ),
    createFeedbackUploadUrl: async (input, provider) => {
      const result = await auth.createFeedbackUploadUrl(
        {
          file_hash: input.sha256,
          file_name: input.filename,
          file_size: input.size,
          feedback_id: input.feedbackId,
        },
        provider,
      );
      if (result.kind === 'error') return result;
      return {
        kind: 'ok',
        uploadId: result.upload_id,
        parts: result.parts.map((part) => ({
          partNumber: part.part_number,
          url: part.url,
          method: part.method,
          size: part.size,
        })),
      };
    },
    completeFeedbackUpload: (input, provider) =>
      auth.completeFeedbackUpload(
        {
          upload_id: input.uploadId,
          parts: input.parts.map((part) => ({
            part_number: part.partNumber,
            etag: part.etag,
          })),
        },
        provider,
      ),
  };
}

async function runKlientLogin(
  auth: KlientAuth,
  provider: string | undefined,
  options: RuntimeAuthLoginOptions,
): Promise<void> {
  if (isAborted(options.signal)) {
    return cancelAbortedLogin(auth, provider);
  }

  const started = await auth.startLogin(provider);
  const activeProvider = started.provider;
  if (isAborted(options.signal)) {
    return cancelAbortedLogin(auth, activeProvider);
  }
  if (started.status === 'authenticated') return;

  await options.onDeviceCode?.(projectKlientDeviceCode(started));
  if (isAborted(options.signal)) {
    return cancelAbortedLogin(auth, activeProvider);
  }

  let interval = started.interval;
  while (true) {
    try {
      await waitForPoll(interval, options.signal);
    } catch (error) {
      if (!isAbortError(error)) throw error;
      return cancelAbortedLogin(auth, activeProvider);
    }

    const flow = await auth.flow(activeProvider);
    if (isAborted(options.signal)) {
      return cancelAbortedLogin(auth, activeProvider);
    }
    if (flow === undefined) {
      throw new Error(
        `Authentication login flow for provider "${activeProvider}" is no longer available.`,
      );
    }
    if (flow.status === 'authenticated') return;
    const errorMessage = flow.error_message?.trim();
    if (errorMessage) {
      throw new Error(
        `Authentication login failed for provider "${flow.provider}": ${errorMessage}`,
      );
    }
    if (flow.status !== 'pending') {
      throw terminalFlowError(flow);
    }
    interval = flow.interval;
  }
}

function projectKlientDeviceCode(
  flow: KlientPendingFlow,
): RuntimeAuthDeviceCode {
  return {
    verificationUri: flow.verification_uri,
    verificationUriComplete: flow.verification_uri_complete,
    userCode: flow.user_code,
    expiresIn: flow.expires_in,
    interval: flow.interval,
  };
}

function terminalFlowError(flow: KlientFlowSnapshot): Error {
  return new Error(
    `Authentication login for provider "${flow.provider}" was ${flow.status}.`,
  );
}

async function cancelAbortedLogin(
  auth: KlientAuth,
  provider: string | undefined,
): Promise<never> {
  try {
    await auth.cancelLogin(provider);
  } catch (error) {
    throw abortError(error);
  }
  throw abortError();
}

function waitForPoll(
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, intervalSeconds) * 1_000);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function abortError(cause?: unknown): Error {
  const error = new Error('Authentication login was aborted.', { cause });
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
