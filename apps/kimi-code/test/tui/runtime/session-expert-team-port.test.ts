/**
 * Scenario: expert-team discovery and control cross a bound TUI session boundary.
 * Responsibilities: both adapters converge definitions and live snapshots,
 * preserve the selected session scope, and detach returned collections from
 * runtime-owned data. The legacy Session or Klient session facade is the
 * single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-expert-team-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionExpertTeamPort } from '#/tui/runtime/klient-session-expert-team-adapter';
import { createLegacySessionExpertTeamPort } from '#/tui/runtime/legacy-session-expert-team-adapter';

describe('legacy session expert-team adapter', () => {
  it('list maps legacy definitions to the neutral team view', async () => {
    const rig = legacyRig({
      listExpertTeams: vi.fn(async () => [legacyDefinition()]),
    });

    const result = await rig.port.list();

    expect(result).toEqual([
      {
        pluginId: 'software-company',
        pluginVersion: '1.2.3',
        displayName: 'Software Company',
        description: 'Ship reliable software',
        leadAgentName: 'team-lead',
        memberAgentNames: ['engineer', 'reviewer'],
        quickPrompts: ['Build a feature', 'Review a change'],
      },
    ]);
  });

  it('list copies legacy definition collections out of the runtime', async () => {
    const definition = legacyDefinition();
    const definitions = [definition];
    const rig = legacyRig({
      listExpertTeams: vi.fn(async () => definitions),
    });

    const result = await rig.port.list();

    expect(result).not.toBe(definitions);
    expect(result[0]?.memberAgentNames).not.toBe(definition.memberAgentNames);
    expect(result[0]?.quickPrompts).not.toBe(definition.quickPrompts);
  });

  it('get maps the legacy status roster to the neutral snapshot', async () => {
    const rig = legacyRig({
      getExpertTeamStatus: vi.fn(async () => legacyStatus()),
    });

    const result = await rig.port.get();

    expect(result).toEqual({
      pluginId: 'software-company',
      pluginVersion: '1.2.3',
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T01:00:00.000Z',
      members: [
        { name: 'engineer', agentId: 'agent-1', status: 'running' },
        { name: 'reviewer', agentId: undefined, status: 'not_started' },
      ],
    });
  });

  it('get copies the legacy status roster and member views', async () => {
    const status = legacyStatus();
    const rig = legacyRig({
      getExpertTeamStatus: vi.fn(async () => status),
    });

    const result = await rig.port.get();

    expect(result?.members).not.toBe(status.members);
    expect(result?.members?.[0]).not.toBe(status.members[0]);
  });

  it('get returns null when the bound legacy session has no active team', async () => {
    const rig = legacyRig({
      getExpertTeamStatus: vi.fn(async () => null),
    });

    await expect(rig.port.get()).resolves.toBeNull();
  });

  it('activate preserves unavailable legacy roster data as undefined', async () => {
    const activateExpertTeam = vi.fn(async () => legacySnapshot());
    const rig = legacyRig({ activateExpertTeam });

    const result = await rig.port.activate('software-company');

    expect(activateExpertTeam).toHaveBeenCalledWith('software-company');
    expect(result).toEqual({
      pluginId: 'software-company',
      pluginVersion: '1.2.3',
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T01:00:00.000Z',
      members: undefined,
    });
  });

  it('deactivate targets the bound legacy session', async () => {
    const deactivateExpertTeam = vi.fn(async () => undefined);
    const rig = legacyRig({ deactivateExpertTeam });

    await rig.port.deactivate();

    expect(deactivateExpertTeam).toHaveBeenCalledOnce();
  });
});

describe('Klient session expert-team adapter', () => {
  it('list maps Klient definitions to the neutral team view', async () => {
    const rig = klientRig({
      list: vi.fn(async () => [klientDefinition()]),
    });

    const result = await rig.port.list();

    expect(result).toEqual([
      {
        pluginId: 'software-company',
        pluginVersion: '2.0.0',
        displayName: 'Software Company',
        description: 'Ship reliable software',
        leadAgentName: 'team-lead',
        memberAgentNames: ['engineer', 'reviewer'],
        quickPrompts: ['Build a feature', 'Review a change'],
      },
    ]);
  });

  it('list copies Klient definition collections out of the runtime', async () => {
    const definition = klientDefinition();
    const definitions = [definition];
    const rig = klientRig({
      list: vi.fn(async () => definitions),
    });

    const result = await rig.port.list();

    expect(result).not.toBe(definitions);
    expect(result[0]?.memberAgentNames).not.toBe(definition.memberAgentNames);
    expect(result[0]?.quickPrompts).not.toBe(definition.quickPrompts);
  });

  it('get maps Klient binding and team runtime to the neutral snapshot', async () => {
    const rig = klientRig({
      get: vi.fn(async () => klientSnapshot()),
    });

    const result = await rig.port.get();

    expect(result).toEqual({
      pluginId: 'software-company',
      pluginVersion: '2.0.0',
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T02:00:00.000Z',
      members: [
        { name: 'engineer', agentId: 'agent-2', status: 'running' },
        { name: 'reviewer', agentId: 'agent-3', status: 'completed' },
      ],
    });
  });

  it('get copies the Klient runtime roster and member views', async () => {
    const snapshot = klientSnapshot();
    const rig = klientRig({
      get: vi.fn(async () => snapshot),
    });

    const result = await rig.port.get();

    expect(result?.members).not.toBe(snapshot.team?.members);
    expect(result?.members?.[0]).not.toBe(snapshot.team?.members[0]);
  });

  it('get does not fabricate a roster before Klient creates the live team', async () => {
    const rig = klientRig({
      get: vi.fn(async () => klientSnapshot(false)),
    });

    const result = await rig.port.get();

    expect(result?.members).toBeUndefined();
  });

  it('activate maps the selected Klient session snapshot', async () => {
    const activate = vi.fn(async () => klientSnapshot());
    const rig = klientRig({ activate });

    const result = await rig.port.activate('software-company');

    expect(activate).toHaveBeenCalledWith('software-company');
    expect(result.members).toEqual([
      { name: 'engineer', agentId: 'agent-2', status: 'running' },
      { name: 'reviewer', agentId: 'agent-3', status: 'completed' },
    ]);
  });

  it('deactivate targets the bound Klient session scope', async () => {
    const deactivate = vi.fn(async () => undefined);
    const rig = klientRig({ deactivate });

    await rig.port.deactivate();

    expect(deactivate).toHaveBeenCalledOnce();
  });
});

function legacyDefinition() {
  return {
    pluginId: 'software-company',
    pluginVersion: '1.2.3',
    displayName: 'Software Company',
    description: 'Ship reliable software',
    profession: 'Software delivery',
    tags: ['engineering'],
    leadAgentName: 'team-lead',
    memberAgentNames: ['engineer', 'reviewer'],
    members: [],
    quickPrompts: ['Build a feature', 'Review a change'],
    defaultInitPrompt: 'Inspect the request.',
    categoryId: 'software',
  };
}

function legacySnapshot() {
  return {
    pluginId: 'software-company',
    pluginVersion: '1.2.3',
    displayName: 'Software Company',
    leadAgentName: 'team-lead',
    previousProfileName: 'default',
    activatedAt: '2026-07-27T01:00:00.000Z',
  };
}

function legacyStatus() {
  return {
    pluginId: 'software-company',
    pluginVersion: '1.2.3',
    displayName: 'Software Company',
    leadAgentName: 'team-lead',
    activatedAt: '2026-07-27T01:00:00.000Z',
    members: [
      { name: 'engineer', agentId: 'agent-1', status: 'running' as const },
      { name: 'reviewer', agentId: undefined, status: 'not_started' as const },
    ],
  };
}

function klientDefinition() {
  return {
    pluginId: 'software-company',
    pluginVersion: '2.0.0',
    displayName: 'Software Company',
    description: 'Ship reliable software',
    profession: 'Software delivery',
    tags: ['engineering'],
    leadAgentName: 'team-lead',
    memberAgentNames: ['engineer', 'reviewer'],
    members: [],
    quickPrompts: ['Build a feature', 'Review a change'],
    defaultInitPrompt: 'Inspect the request.',
    categoryId: 'software',
  };
}

function klientSnapshot(includeTeam = true) {
  return {
    binding: {
      pluginId: 'software-company',
      pluginVersion: '2.0.0',
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      leadProfileName: 'expert:team-lead',
      memberAgentNames: ['engineer', 'reviewer'],
      previousProfile: {
        profileName: 'default',
        modelAlias: 'example/model',
        thinkingLevel: 'high',
        cwd: '/workspace',
        systemPrompt: 'You are Kimi.',
      },
      activatedAt: '2026-07-27T02:00:00.000Z',
    },
    team: includeTeam
      ? {
          id: 'team-1',
          name: 'Software Company',
          description: 'Ship reliable software',
          createdAt: '2026-07-27T02:01:00.000Z',
          members: [
            {
              name: 'engineer',
              agentId: 'agent-2',
              profileName: 'expert:engineer',
              status: 'running' as const,
              updatedAt: '2026-07-27T02:02:00.000Z',
              taskId: 'task-1',
            },
            {
              name: 'reviewer',
              agentId: 'agent-3',
              profileName: 'expert:reviewer',
              status: 'completed' as const,
              updatedAt: '2026-07-27T02:03:00.000Z',
            },
          ],
        }
      : undefined,
  };
}

function legacyRig(
  overrides: Partial<{
    listExpertTeams: () => Promise<readonly ReturnType<typeof legacyDefinition>[]>;
    getExpertTeamStatus: () => Promise<ReturnType<typeof legacyStatus> | null>;
    activateExpertTeam: (
      pluginId: string,
    ) => Promise<ReturnType<typeof legacySnapshot>>;
    deactivateExpertTeam: () => Promise<void>;
  }> = {},
) {
  const session = {
    listExpertTeams:
      overrides.listExpertTeams ?? vi.fn(async () => []),
    getExpertTeamStatus:
      overrides.getExpertTeamStatus ?? vi.fn(async () => null),
    activateExpertTeam:
      overrides.activateExpertTeam ?? vi.fn(async () => legacySnapshot()),
    deactivateExpertTeam:
      overrides.deactivateExpertTeam ?? vi.fn(async () => undefined),
  };
  return {
    port: createLegacySessionExpertTeamPort(session),
    session,
  };
}

function klientRig(
  overrides: Partial<{
    list: () => Promise<readonly ReturnType<typeof klientDefinition>[]>;
    get: () => Promise<ReturnType<typeof klientSnapshot> | null>;
    activate: (
      pluginId: string,
    ) => Promise<ReturnType<typeof klientSnapshot>>;
    deactivate: () => Promise<void>;
  }> = {},
) {
  const expertTeam = {
    list: overrides.list ?? vi.fn(async () => []),
    get: overrides.get ?? vi.fn(async () => null),
    activate:
      overrides.activate ?? vi.fn(async () => klientSnapshot()),
    deactivate:
      overrides.deactivate ?? vi.fn(async () => undefined),
  };
  return {
    port: createKlientSessionExpertTeamPort({ expertTeam }),
    expertTeam,
  };
}
