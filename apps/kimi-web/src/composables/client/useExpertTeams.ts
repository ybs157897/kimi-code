// apps/kimi-web/src/composables/client/useExpertTeams.ts
// Expert-team catalog loading + activation actions. Extracted from
// useWorkspaceState to keep each composable single-purpose.

import { watch, type Ref } from 'vue';
import { getKimiWebApi } from '../../api';
import type { AppExpertTeam, AppExpertTeamStatus } from '../../api/types';
import { i18n } from '../../i18n';
import type { ExtendedState } from '../useKimiWebClient';

export interface DraftExpertModes {
  planMode: boolean;
  swarmMode: boolean;
  goalMode: boolean;
  expertTeamPluginId: string | null;
}

export interface UseExpertTeamsDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  draftModes: DraftExpertModes;
  draftExpertTeams: Ref<AppExpertTeam[]>;
}

/** Build a display-only status for a staged (not-yet-activated) draft pick. */
export function draftExpertTeamStatus(
  pluginId: string,
  catalog: readonly AppExpertTeam[],
): AppExpertTeamStatus {
  const team = catalog.find((t) => t.pluginId === pluginId);
  return {
    pluginId,
    displayName: team?.displayName ?? pluginId,
    leadAgentName: team?.leadAgentName ?? '',
    memberAgentNames: team?.memberAgentNames ?? [],
    activatedAt: '',
    teamMembers: [],
  };
}

export function useExpertTeams(rawState: ExtendedState, deps: UseExpertTeamsDeps) {
  const { pushOperationFailure, draftModes, draftExpertTeams } = deps;

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
      // Keep the draft catalog warm so switching to "new" still shows the picker.
      draftExpertTeams.value = teams;
    } catch {
      // Old/incompatible server — hide the feature rather than toast.
    }
  }

  /** Load the catalog for the empty-composer draft by borrowing any known
   *  session id (list is plugin-scoped; the session is only a route host). */
  async function loadDraftExpertTeams(): Promise<void> {
    if (rawState.backend !== 'v2') return;
    const borrowId = rawState.sessions[0]?.id;
    if (!borrowId) return;
    try {
      const teams = await getKimiWebApi().listExpertTeams(borrowId);
      draftExpertTeams.value = teams;
    } catch {
      // Old/incompatible server — leave the draft catalog empty.
    }
  }

  async function activateExpertTeam(pluginId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) {
      draftModes.expertTeamPluginId = pluginId;
      // Expert-team mode owns the main agent; keep draft swarm off to match
      // the daemon's force-exit behavior on activate.
      draftModes.swarmMode = false;
      return;
    }
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
    if (!sid) {
      draftModes.expertTeamPluginId = null;
      return;
    }
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

  /** Apply a staged draft expert-team pick onto a freshly created session. */
  async function applyDraftExpertTeam(sessionId: string): Promise<void> {
    const pluginId = draftModes.expertTeamPluginId;
    draftModes.expertTeamPluginId = null;
    if (!pluginId) return;
    try {
      const status = await getKimiWebApi().activateExpertTeam(sessionId, pluginId);
      rawState.expertTeamStatusBySession = {
        ...rawState.expertTeamStatusBySession,
        [sessionId]: status,
      };
      rawState.swarmModeBySession = { ...rawState.swarmModeBySession, [sessionId]: false };
    } catch (err) {
      pushOperationFailure('activateExpertTeam', err, { sessionId });
    }
  }

  /** Re-scan the expert-team catalog (Modes menu open / entering draft). */
  function refreshExpertTeams(): void {
    const sid = rawState.activeSessionId;
    if (sid) {
      void loadExpertTeamsForSession(sid);
      return;
    }
    void loadDraftExpertTeams();
  }

  // Member name/profession are mapped through the UI locale; re-fetch when it
  // flips so { en, zh } packs don't keep the previous language's labels.
  watch(
    () => i18n.global.locale.value,
    () => {
      refreshExpertTeams();
    },
  );

  return {
    loadExpertTeamsForSession,
    loadDraftExpertTeams,
    activateExpertTeam,
    deactivateExpertTeam,
    applyDraftExpertTeam,
    refreshExpertTeams,
  };
}
