import { ExpertTeamSelectorComponent } from '../components/dialogs/expert-team-selector';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type {
  SessionExpertTeamMember,
  SessionExpertTeamMemberStatus,
  SessionExpertTeamSnapshot,
} from '../runtime/session-expert-team-port';
import type { TUISessionRuntime } from '../runtime/tui-session-runtime';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleExpertsCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  let runtime: TUISessionRuntime;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const input = args.trim();
  if (input.toLowerCase() === 'status') {
    await showExpertTeamStatus(host, runtime);
    return;
  }

  const teams = await runtime.expertTeam.list();
  if (input.length > 0) {
    if (input.toLowerCase() === 'off' || input.toLowerCase() === 'standard') {
      await applyExpertTeam(host, runtime, null);
      return;
    }
    const team = teams.find((candidate) => candidate.pluginId === input);
    if (team === undefined) {
      host.showError(`Expert team plugin "${input}" was not found.`);
      return;
    }
    await applyExpertTeam(host, runtime, team.pluginId);
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
        void applyExpertTeam(host, runtime, pluginId);
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
  runtime: TUISessionRuntime,
  pluginId: string | null,
): Promise<void> {
  try {
    if (pluginId === null) {
      await runtime.expertTeam.deactivate();
      host.setAppState({ expertTeam: null, expertTeamMembers: [] });
      host.showNotice('Expert team: OFF', 'Restored the standard Kimi agent.');
      return;
    }
    if (host.state.appState.swarmMode) {
      await runtime.swarm.exit();
    }
    const expertTeam = await runtime.expertTeam.activate(pluginId);
    const status = await runtime.expertTeam.get();
    const members = toAppStateMembers(status?.members ?? []);
    host.setAppState({
      expertTeam,
      expertTeamMembers: members,
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

async function showExpertTeamStatus(
  host: SlashCommandHost,
  runtime: TUISessionRuntime,
): Promise<void> {
  try {
    const status = await runtime.expertTeam.get();
    if (status === null) {
      host.showNotice('Expert team: OFF', 'The standard Kimi agent is active.');
      return;
    }
    const members = status.members ?? [];
    host.setAppState({
      expertTeam: status,
      expertTeamMembers: toAppStateMembers(members),
    });
    host.showNotice(`Expert team: ${status.displayName}`, formatExpertTeamStatus(status));
  } catch (error) {
    host.showError(`Failed to read expert team status: ${formatErrorMessage(error)}`);
  }
}

function formatExpertTeamStatus(status: SessionExpertTeamSnapshot): string {
  const roster = status.members ?? [];
  const members =
    roster.length === 0
      ? ['- none']
      : roster.map((member) => `- [${formatMemberPhase(member.status)}] ${member.name}`);
  return [`Lead: ${status.leadAgentName}`, 'Members:', ...members].join('\n');
}

function formatMemberPhase(phase: SessionExpertTeamMemberStatus): string {
  return phase === 'not_started' ? 'not started' : phase;
}

function toAppStateMembers(
  members: readonly SessionExpertTeamMember[],
): NonNullable<Parameters<SlashCommandHost['setAppState']>[0]['expertTeamMembers']> {
  return members as NonNullable<
    Parameters<SlashCommandHost['setAppState']>[0]['expertTeamMembers']
  >;
}
