// apps/kimi-web/src/composables/client/useAuthConfig.ts
// Auth readiness checks + global config load/update. Extracted from
// useWorkspaceState to keep each composable single-purpose.

import type { Ref } from 'vue';
import { getKimiWebApi } from '../../api';
import { isDaemonApiError } from '../../api/errors';
import { SERVER_AUTH_UNAUTHORIZED_CODE } from '../../api/daemon/http';
import type { AppConfig } from '../../api/types';
import type { ExtendedState } from '../useKimiWebClient';
import type { AuthCheckResult } from './useWorkspaceStateTypes';
import { FIRST_LOAD_AUTH_RETRY_MS } from './workspaceStateConstants';

export interface UseAuthConfigDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  /** Diagnostic for the connecting splash, set by checkAuth on transient
   *  failures and cleared once a check gets through. */
  connectIssue: Ref<string | null>;
}

export function useAuthConfig(rawState: ExtendedState, deps: UseAuthConfigDeps) {
  const { pushOperationFailure, connectIssue } = deps;

  /** Fetch auth readiness from GET /api/v1/auth. Defensive — never throws.
   *  The web bundle always ships paired with its daemon, so this endpoint is
   *  guaranteed to exist — every failure is either a credential rejection or
   *  a transient error worth retrying:
   *  - 'proceed'              — response received; rawState reflects it (ready
   *                             or not)
   *  - 'server-auth-required' — the daemon rejected our server credential
   *                             (401/40101); the ServerAuthDialog owns recovery
   *                             (it reloads once the token is entered)
   *  - 'retry'                — transient failure (network, timeout, 5xx); the
   *                             caller should retry instead of treating it as
   *                             "not signed in" */
  async function checkAuth(): Promise<AuthCheckResult> {
    try {
      const api = getKimiWebApi();
      const result = await api.getAuth();
      rawState.authReady = result.ready;
      rawState.defaultModel = result.defaultModel;
      rawState.managedProviderStatus = result.managedProvider?.status ?? null;
      connectIssue.value = null;
      return 'proceed';
    } catch (err) {
      if (
        isDaemonApiError(err) &&
        (err.code === 401 || err.code === SERVER_AUTH_UNAUTHORIZED_CODE)
      ) {
        // The ServerAuthDialog explains this one — nothing to surface.
        connectIssue.value = null;
        return 'server-auth-required';
      }
      // Surface the reason on the splash so "cannot connect" is diagnosable
      // instead of an unexplained spinner.
      connectIssue.value = (err instanceof Error ? err.message : String(err)).slice(0, 140);
      return 'retry';
    }
  }

  /** Poll /auth until the daemon gives a definitive outcome, waiting
   *  FIRST_LOAD_AUTH_RETRY_MS between transient failures. Never resolves with
   *  'retry'. Used only by the first load. */
  async function waitForFirstAuth(): Promise<AuthCheckResult> {
    let firstRetry = true;
    for (;;) {
      const result = await checkAuth();
      if (result !== 'retry') return result;
      // Keep the first quick failure silent — a single blip right after page
      // load shouldn't flash an error. Surface it from the 2nd failed attempt
      // (~2s in) onward, so a genuinely stuck connection stays diagnosable.
      if (firstRetry) {
        connectIssue.value = null;
        firstRetry = false;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, FIRST_LOAD_AUTH_RETRY_MS);
      });
    }
  }

  /** Fetch global config from GET /api/v1/config. Defensive — never throws. */
  async function loadConfig(): Promise<void> {
    try {
      const api = getKimiWebApi();
      rawState.config = await api.getConfig();
    } catch {
      // Daemon may not have this endpoint yet; leave null
    }
  }

  /** Update global config via POST /api/v1/config. */
  async function updateConfig(patch: Partial<AppConfig>): Promise<boolean> {
    try {
      const api = getKimiWebApi();
      const next = await api.setConfig(patch);
      rawState.config = next;
      rawState.defaultModel = next.defaultModel ?? null;
      return true;
    } catch (err) {
      pushOperationFailure('setConfig', err);
      return false;
    }
  }

  return {
    checkAuth,
    waitForFirstAuth,
    loadConfig,
    updateConfig,
  };
}
