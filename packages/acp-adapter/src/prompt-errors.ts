import { RequestError } from '@agentclientprotocol/sdk';
import { ErrorCodes, log } from '@moonshot-ai/kimi-code-sdk';

export function mapPromptError(err: unknown, sessionId: string): RequestError {
  const authErr = authRequiredFromUnknown(err);
  if (authErr) {
    log.warn('acp: prompt rejected with auth error; mapping to authRequired', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return authErr;
  }
  log.error('acp: prompt failed', {
    sessionId,
    error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
  });
  return RequestError.internalError(undefined, 'session prompt failed');
}

/**
 * Inspect a {@link KimiErrorPayload} (as carried on `turn.ended`
 * failed events) and return a `RequestError.authRequired()` if its
 * `code` is one of the auth-required codes; otherwise `undefined`.
 *
 * Kept separate from {@link authRequiredFromUnknown} because the
 * `turn.ended` event hands us a serialized payload (no class identity
 * to branch on) — we only need the `code` discriminator here.
 */
export function authRequiredFromPayload(
  payload: { readonly code: unknown } | undefined,
): RequestError | undefined {
  if (!payload) return undefined;
  if (isAuthErrorCode(payload.code)) {
    return RequestError.authRequired();
  }
  return undefined;
}

/**
 * Type-narrowing predicate for the codes the adapter treats as
 * "the client must re-authenticate before retrying". Currently:
 *  - `auth.login_required` — Kimi Platform / OAuth login flow needed.
 *  - `provider.auth_error` — the downstream provider rejected the
 *    request with a 401 (the node SDK lifts these into `KimiError`
 *    at `kimi-code-model-provider.ts:99-103`).
 */
export function isAuthErrorCode(code: unknown): boolean {
  return code === ErrorCodes.AUTH_LOGIN_REQUIRED || code === ErrorCodes.PROVIDER_AUTH_ERROR;
}

/**
 * Best-effort detection of "auth required" for the `session.prompt(...)`
 * rejection path. The thrown value MAY be:
 *  - A `KimiError` instance with a recognized `code` field.
 *  - A plain object that happens to expose a `code` (covers RPC-layer
 *    deserialized payloads that lost class identity).
 *  - Anything else — returns `undefined`.
 */
export function authRequiredFromUnknown(err: unknown): RequestError | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (isAuthErrorCode(code)) {
      return RequestError.authRequired();
    }
  }
  return undefined;
}
