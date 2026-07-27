// Session-scoped code-extension command catalog and control operations.
// Only serializable command metadata reaches the browser; extension callbacks
// stay inside the v2 engine.

import { ref } from 'vue';

import { getKimiWebApi } from '../../api';
import type {
  AppExtensionCommand,
  AppExtensionReloadResult,
} from '../../api/types';
import type { ExtendedState } from '../useKimiWebClient';

export interface UseExtensionStateDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
}

export function useExtensionState(
  rawState: ExtendedState,
  deps: UseExtensionStateDeps,
) {
  const { pushOperationFailure } = deps;
  const commandsBySession = ref<Record<string, AppExtensionCommand[]>>({});

  async function loadCommandsForSession(sessionId: string): Promise<void> {
    try {
      const commands = await getKimiWebApi().listExtensionCommands(sessionId);
      commandsBySession.value = {
        ...commandsBySession.value,
        [sessionId]: commands,
      };
    } catch {
      // v1/older daemons have no extension control plane; built-in commands
      // and skills remain usable. Clear any catalog cached from a previous
      // backend generation so stale commands cannot remain actionable.
      commandsBySession.value = {
        ...commandsBySession.value,
        [sessionId]: [],
      };
    }
  }

  async function reload(
    sessionId?: string,
  ): Promise<AppExtensionReloadResult | undefined> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return undefined;
    try {
      const result = await getKimiWebApi().reloadExtensions(sid);
      await loadCommandsForSession(sid);
      const firstError = result.errors[0];
      if (firstError !== undefined) {
        const remaining = result.errors.length - 1;
        const suffix = remaining > 0 ? ` (${remaining} more)` : '';
        const message = `${firstError.path}: ${firstError.error}${suffix}`;
        pushOperationFailure('reloadExtensions', new Error(message), {
          title: 'Extension reload failed',
          message,
          sessionId: sid,
        });
      }
      return result;
    } catch (err) {
      pushOperationFailure('reloadExtensions', err, { sessionId: sid });
      return undefined;
    }
  }

  async function activateCommand(
    extensionId: string,
    name: string,
    args?: string,
    sessionId?: string,
  ): Promise<void> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return;
    try {
      const result = await getKimiWebApi().activateExtensionCommand(
        sid,
        extensionId,
        name,
        args,
      );
      if (!result.activated) {
        await loadCommandsForSession(sid);
        pushOperationFailure(
          'activateExtensionCommand',
          new Error(`Extension command "${extensionId}:${name}" is not available`),
          { sessionId: sid },
        );
      }
    } catch (err) {
      pushOperationFailure('activateExtensionCommand', err, { sessionId: sid });
    }
  }

  return {
    commandsBySession,
    loadCommandsForSession,
    reload,
    activateCommand,
  };
}

export type UseExtensionState = ReturnType<typeof useExtensionState>;
