import { describe, expect, it, vi } from 'vitest';

import { handleExpertsCommand } from '#/tui/commands';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

/**
 * Scenario: /experts controls expert-team state through the active TUI runtime.
 *
 * Responsibilities: prove activation, deactivation, status rendering, and selector
 * presentation continue to work without a legacy SDK Session.
 *
 * Wiring: a runtime-only command host supplies neutral expert-team and swarm ports.
 *
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/experts.test.ts
 */
function makeHost(options: { swarmMode?: boolean; active?: boolean } = {}) {
  const snapshot = {
    pluginId: 'software-company',
    displayName: 'Software Company',
    leadAgentName: 'software-team-lead',
    activatedAt: '2026-07-26T00:00:00.000Z',
  };
  const status = {
    ...snapshot,
    members: [
      {
        name: 'software-engineer',
        agentId: 'agent-1',
        status: 'running' as const,
      },
      {
        name: 'reviewer',
        status: 'not_started' as const,
      },
    ],
  };
  const expertTeam = {
    list: vi.fn(async () => [
      {
        pluginId: 'software-company',
        displayName: 'Software Company',
        description: 'Software delivery team',
        leadAgentName: 'software-team-lead',
        memberAgentNames: ['software-engineer'],
        quickPrompts: [],
      },
    ]),
    activate: vi.fn(async () => snapshot),
    get: vi.fn(async () => status),
    deactivate: vi.fn(async () => {}),
  };
  const swarm = {
    exit: vi.fn(async () => {}),
  };
  const runtime = {
    expertTeam,
    swarm,
  };
  const host = {
    state: {
      appState: {
        swarmMode: options.swarmMode ?? false,
        expertTeam: options.active ? snapshot : null,
      },
    },
    session: undefined,
    requireSessionRuntime: vi.fn(() => runtime),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, expertTeam, swarm, snapshot, status };
}

describe('handleExpertsCommand', () => {
  it('activates a team from a runtime-only host and exits swarm mode', async () => {
    const { host, expertTeam, swarm, snapshot, status } = makeHost({ swarmMode: true });

    await handleExpertsCommand(host, 'software-company');

    expect(swarm.exit).toHaveBeenCalledOnce();
    expect(expertTeam.activate).toHaveBeenCalledWith('software-company');
    expect(host.setAppState).toHaveBeenCalledWith({
      expertTeam: snapshot,
      expertTeamMembers: status.members,
      swarmMode: false,
    });
    expect(host.showNotice).toHaveBeenCalledWith(
      'Expert team: Software Company',
      'Lead: software-team-lead',
    );
  });

  it('returns to the standard agent with /experts off', async () => {
    const { host, expertTeam } = makeHost({ active: true });

    await handleExpertsCommand(host, 'off');

    expect(expertTeam.deactivate).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({
      expertTeam: null,
      expertTeamMembers: [],
    });
  });

  it('shows the complete live roster with /experts status', async () => {
    const { host, expertTeam, status } = makeHost({ active: true });

    await handleExpertsCommand(host, 'status');

    expect(expertTeam.list).not.toHaveBeenCalled();
    expect(expertTeam.get).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({
      expertTeam: status,
      expertTeamMembers: status.members,
    });
    expect(host.showNotice).toHaveBeenCalledWith(
      'Expert team: Software Company',
      [
        'Lead: software-team-lead',
        'Members:',
        '- [running] software-engineer',
        '- [not started] reviewer',
      ].join('\n'),
    );
  });

  it('opens the searchable selector with the active team marked', async () => {
    const { host } = makeHost({ active: true });

    await handleExpertsCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const picker = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { render(width: number): string[] };
    expect(picker.render(120).join('\n')).toContain('Software Company');
  });
});
