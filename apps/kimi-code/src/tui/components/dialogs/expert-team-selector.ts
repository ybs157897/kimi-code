import type {
  SessionExpertTeamDefinition,
  SessionExpertTeamSnapshot,
} from '#/tui/runtime/session-expert-team-port';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export interface ExpertTeamSelectorOptions {
  readonly teams: readonly SessionExpertTeamDefinition[];
  readonly current: SessionExpertTeamSnapshot | null;
  readonly onSelect: (pluginId: string | null) => void;
  readonly onCancel: () => void;
}

export class ExpertTeamSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ExpertTeamSelectorOptions) {
    const options: ChoiceOption[] = [
      {
        value: '',
        label: 'Standard',
        description: 'Use the standard Kimi agent without an expert team.',
      },
      ...opts.teams.map((team) => ({
        value: team.pluginId,
        label: team.displayName,
        description: expertTeamDescription(team),
      })),
    ];
    super({
      title: 'Select expert team',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      currentValue: opts.current?.pluginId ?? '',
      searchable: true,
      onSelect: (value) => {
        opts.onSelect(value.length === 0 ? null : value);
      },
      onCancel: opts.onCancel,
    });
  }
}

function expertTeamDescription(team: SessionExpertTeamDefinition): string {
  const specialists = `${String(team.memberAgentNames.length)} specialist${
    team.memberAgentNames.length === 1 ? '' : 's'
  }`;
  return [specialists, team.pluginId, team.description].filter(Boolean).join(' · ');
}
