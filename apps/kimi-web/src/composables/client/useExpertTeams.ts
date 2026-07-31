// apps/kimi-web/src/composables/client/useExpertTeams.ts
// Expert-team catalog loading + activation actions. Extracted from
// useWorkspaceState to keep each composable single-purpose.

import { getKimiWebApi } from '../../api';
import type { ExtendedState } from '../useKimiWebClient';

export interface UseExpertTeamsDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
}

export function useExpertTeams(rawState: ExtendedState, deps: UseExpertTeamsDeps) {
  const { pushOperationFailure } = deps;

  /** Load the expert-team catalog + active mode for a session. Defensive —
   *  the surface only exists on v2 backends, so failures just leave the maps
   *  empty and the picker hidden. Re-scanned on every sidecar refresh because
   *  drop-in team packages can appear on disk while the session is open. */
  async function loadExpertTeamsForSession(sessionId: string): Promise<void> {
    if (rawState.backend !== 'v2') return;
    try {
      const api = getKimiWebApi();
      const [teams, status] = await Promise.all([
        api.listExpertTeams(sessionId),
        api.getExpertTeam(sessionId),
      ]);
      rawState.expertTeamsBySession = { ...rawState.expertTeamsBySession, [sessionId]: teams };
      rawState.expertTeamStatusBySession = {
        ...rawState.expertTeamStatusBySession,
        [sessionId]: status,
      };
    } catch {
      // Old/incompatible server — hide the feature rather than toast.
    }
  }

  async function activateExpertTeam(pluginId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    try {
      const status = await getKimiWebApi().activateExpertTeam(sid, pluginId);
      rawState.expertTeamStatusBySession = {
        ...rawState.expertTeamStatusBySession,
        [sid]: status,
      };
      // Expert-team mode owns the main agent; the daemon force-exits swarm.
      rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [sid]: false };
    } catch (err) {
      pushOperationFailure('activateExpertTeam', err, { sessionId: sid });
    }
  }

  async function deactivateExpertTeam(): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    try {
      await getKimiWebApi().deactivateExpertTeam(sid);
      rawState.expertTeamStatusBySession = {
        ...rawState.expertTeamStatusBySession,
        [sid]: null,
      };
    } catch (err) {
      pushOperationFailure('deactivateExpertTeam', err, { sessionId: sid });
    }
  }

  /** Re-scan the active session's expert-team catalog (Modes menu open). */
  function refreshExpertTeams(): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    void loadExpertTeamsForSession(sid);
  }

  return {
    loadExpertTeamsForSession,
    activateExpertTeam,
    deactivateExpertTeam,
    refreshExpertTeams,
  };
}
