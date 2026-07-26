import type { ExpertTeamStatusSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { ExpertTeamSelectorComponent } from '../components/dialogs/expert-team-selector';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleExpertsCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const input = args.trim();
  if (input.toLowerCase() === 'status') {
    await showExpertTeamStatus(host);
    return;
  }

  const teams = await session.listExpertTeams();
  if (input.length > 0) {
    if (input.toLowerCase() === 'off' || input.toLowerCase() === 'standard') {
      await applyExpertTeam(host, null);
      return;
    }
    const team = teams.find((candidate) => candidate.pluginId === input);
    if (team === undefined) {
      host.showError(`Expert team plugin "${input}" was not found.`);
      return;
    }
    await applyExpertTeam(host, team.pluginId);
    return;
  }

  if (
    teams.length === 0 &&
    (host.state.appState.expertTeam === null ||
      host.state.appState.expertTeam === undefined)
  ) {
    host.showNotice(
      'No expert teams installed',
      'Drop a team package into .kimi-code/experts/ (or ~/.kimi-code/experts/), or install an expert plugin with /plugins install <path>.',
    );
    return;
  }

  host.mountEditorReplacement(
    new ExpertTeamSelectorComponent({
      teams,
      current: host.state.appState.expertTeam ?? null,
      onSelect: (pluginId) => {
        host.restoreEditor();
        void applyExpertTeam(host, pluginId);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus('Expert team selection cancelled.');
      },
    }),
  );
}

async function applyExpertTeam(
  host: SlashCommandHost,
  pluginId: string | null,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  try {
    if (pluginId === null) {
      await session.deactivateExpertTeam();
      host.setAppState({ expertTeam: null, expertTeamMembers: [] });
      host.showNotice('Expert team: OFF', 'Restored the standard Kimi agent.');
      return;
    }
    if (host.state.appState.swarmMode) {
      await session.setSwarmMode(false, 'manual');
    }
    const expertTeam = await session.activateExpertTeam(pluginId);
    const status = await session.getExpertTeamStatus();
    host.setAppState({
      expertTeam,
      expertTeamMembers: status?.members ?? [],
      swarmMode: false,
    });
    host.state.swarmModeEntry = undefined;
    host.showNotice(
      `Expert team: ${expertTeam.displayName}`,
      `Lead: ${expertTeam.leadAgentName}`,
    );
  } catch (error) {
    host.showError(`Failed to change expert team: ${formatErrorMessage(error)}`);
  }
}

async function showExpertTeamStatus(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  try {
    const status = await session.getExpertTeamStatus();
    if (status === null) {
      host.showNotice('Expert team: OFF', 'The standard Kimi agent is active.');
      return;
    }
    host.setAppState({
      expertTeam: status,
      expertTeamMembers: status.members,
    });
    host.showNotice(`Expert team: ${status.displayName}`, formatExpertTeamStatus(status));
  } catch (error) {
    host.showError(`Failed to read expert team status: ${formatErrorMessage(error)}`);
  }
}

function formatExpertTeamStatus(status: ExpertTeamStatusSnapshot): string {
  const members =
    status.members.length === 0
      ? ['- none']
      : status.members.map((member) => `- [${formatMemberPhase(member.status)}] ${member.name}`);
  return [`Lead: ${status.leadAgentName}`, 'Members:', ...members].join('\n');
}

function formatMemberPhase(phase: ExpertTeamStatusSnapshot['members'][number]['status']): string {
  return phase === 'not_started' ? 'not started' : phase;
}
