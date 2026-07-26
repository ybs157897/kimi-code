import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it } from 'vitest';

import { testKaos } from '../fixtures/test-kaos';
import type { ExpertTeamRuntime, ExpertTeamRuntimeState } from '../../src/expert-team';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';

const tempDirs: string[] = [];
const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-expert-team-'));
  tempDirs.push(dir);
  return dir;
}

function sessionRpc(onEvent?: (event: unknown) => void): SDKSessionRPC {
  return {
    emitEvent: async (event: unknown) => {
      onEvent?.(event);
    },
  } as unknown as SDKSessionRPC;
}

function testTeam(): ExpertTeamRuntime {
  const memberProfile: ResolvedAgentProfile = {
    name: 'software-architect',
    systemPrompt: () => 'member prompt',
    tools: ['SendMessage'],
  };
  const memberProfiles = { 'software-architect': memberProfile };
  const leadProfile: ResolvedAgentProfile = {
    name: 'expert:test-team:lead',
    systemPrompt: () => 'lead prompt',
    tools: ['Agent', 'SendMessage'],
    subagents: memberProfiles,
  };
  return {
    pluginId: 'test-team',
    displayName: 'Test Team',
    tags: [],
    leadAgentName: 'lead',
    memberAgentNames: ['software-architect'],
    members: [],
    quickPrompts: [],
    leadProfile,
    memberProfiles,
  };
}

function enabledFlags(): FlagResolver {
  return new FlagResolver(
    { KIMI_CODE_EXPERIMENTAL_EXPERT_TEAMS: '1' },
    FLAG_DEFINITIONS,
  );
}

async function makeSession(
  homedir: string,
  workDir: string,
  onEvent?: (event: unknown) => void,
): Promise<Session> {
  const session = new Session({
    id: 'expert-team-test',
    kaos: testKaos.withCwd(workDir),
    homedir,
    rpc: sessionRpc(onEvent),
    providerManager: new ProviderManager({
      config: {
        providers: {
          test: {
            type: MOCK_PROVIDER.type,
            apiKey: MOCK_PROVIDER.apiKey,
          },
        },
        models: {
          [MOCK_PROVIDER.model]: {
            provider: 'test',
            model: MOCK_PROVIDER.model,
            maxContextSize: 1_000_000,
          },
        },
      },
    }),
    expertTeams: [testTeam()],
    experimentalFlags: enabledFlags(),
  });
  return session;
}

describe('Session expert-team runtime lifecycle', () => {
  it('attaches the mailbox on activate and clears it on deactivate', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    const events: unknown[] = [];
    const session = await makeSession(homedir, workDir, (event) => events.push(event));
    const main = await session.createMain();

    await session.activateExpertTeam('test-team');
    expect(session.getExpertTeamRuntime()).toBeDefined();
    expect(main.team).toBe(session.getExpertTeamRuntime());
    expect(main.teamSelfName).toBe('team-lead');
    expect(session.metadata.expertTeamRuntime).toEqual({
      members: [],
      pendingShutdowns: [],
      journal: [],
    });

    await session.deactivateExpertTeam();
    expect(session.getExpertTeamRuntime()).toBeUndefined();
    expect(main.team).toBeUndefined();
    expect(main.teamSelfName).toBeUndefined();
    expect(session.metadata.expertTeamRuntime).toBeUndefined();
    expect(session.metadata.expertTeam).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: 'expert_team.updated',
      agentId: 'main',
      status: null,
    });
    await session.close();
  });

  it('projects the complete declared roster and emits live member phases', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    const events: unknown[] = [];
    const session = await makeSession(homedir, workDir, (event) => events.push(event));
    await session.createMain();

    await session.activateExpertTeam('test-team');
    expect(session.getExpertTeamStatus()).toMatchObject({
      pluginId: 'test-team',
      displayName: 'Test Team',
      leadAgentName: 'lead',
      members: [{ name: 'software-architect', status: 'not_started' }],
    });

    const runtime = session.getExpertTeamRuntime()!;
    runtime.registerMember('software-architect', 'agent-0');
    expect(session.getExpertTeamStatus()?.members).toEqual([
      { name: 'software-architect', agentId: 'agent-0', status: 'running' },
    ]);
    runtime.markMemberStatus('software-architect', 'idle');

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'expert_team.updated',
        agentId: 'main',
        status: expect.objectContaining({
          members: [{ name: 'software-architect', agentId: 'agent-0', status: 'idle' }],
        }),
      }),
    );
    await session.close();
  });

  it('blocks deactivation until every roster member approves shutdown', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    const session = await makeSession(homedir, workDir);
    await session.createMain();
    await session.activateExpertTeam('test-team');

    const runtime = session.getExpertTeamRuntime()!;
    runtime.registerMember('software-architect', 'agent-0');
    expect(runtime.memberByName('software-architect')?.status).toBe('running');

    await expect(session.deactivateExpertTeam()).rejects.toThrow(
      'Expert team has active members',
    );
    expect(session.metadata.expertTeam).toBeDefined();

    runtime.markMemberStatus('software-architect', 'idle');
    await expect(session.deactivateExpertTeam()).rejects.toThrow(
      'Expert team has active members',
    );

    const request = await runtime.send({
      type: 'shutdown_request',
      from: 'team-lead',
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    expect(requestId).toBeDefined();
    await expect(
      runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 'done',
        requestId,
        approve: true,
      }),
    ).resolves.toMatchObject({ ok: true });

    await session.deactivateExpertTeam();
    expect(session.metadata.expertTeam).toBeUndefined();
    await session.close();
  });

  it('restores the roster as idle and drops stale members on resume', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    {
      const session = await makeSession(homedir, workDir);
      await session.createMain();
      await session.activateExpertTeam('test-team');
      // Simulate a persisted roster: one member with a real agent record, one
      // stale entry whose agent metadata no longer exists.
      const member = await session.createAgent(
        { type: 'sub' },
        {
          parentAgentId: 'main',
          profile: testTeam().memberProfiles['software-architect'],
        },
      );
      expect(member.id).toBe('agent-0');
      const state: ExpertTeamRuntimeState = {
        members: [
          { name: 'software-architect', agentId: 'agent-0' },
          { name: 'ghost', agentId: 'agent-gone' },
        ],
        pendingShutdowns: [],
        journal: [
          {
            id: 'env-1',
            type: 'message',
            from: 'software-architect',
            to: 'team-lead',
            summary: 'undelivered',
            text: 'late result',
            sentAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      session.metadata = { ...session.metadata, expertTeamRuntime: state };
      await session.writeMetadata();
      await session.flushMetadata();
      await session.close();
    }

    const resumed = await makeSession(homedir, workDir);
    await resumed.resume();
    const runtime = resumed.getExpertTeamRuntime();
    expect(runtime).toBeDefined();
    expect(runtime!.memberByName('software-architect')?.status).toBe('idle');
    expect(runtime!.memberByName('ghost')).toBeUndefined();
    expect(runtime!.hasActiveMembers()).toBe(true);
    // The journaled mail was appended to the lead's history, not steered.
    const main = resumed.getReadyAgent('main')!;
    expect(main.turn.hasActiveTurn).toBe(false);
    expect(JSON.stringify(main.context.data().history)).toContain('late result');
    await resumed.close();
  });

  it('drops a roster member whose profile did not finish persisting before restart', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    {
      const session = await makeSession(homedir, workDir);
      await session.createMain();
      await session.activateExpertTeam('test-team');
      const incomplete = await session.createAgent(
        { type: 'sub' },
        { parentAgentId: 'main' },
      );
      const runtime = session.getExpertTeamRuntime()!;
      runtime.registerMember('software-architect', incomplete.id);
      runtime.markMemberStatus('software-architect', 'idle');
      await runtime.persist();
      await session.flushMetadata();
      await session.close();
    }

    const resumed = await makeSession(homedir, workDir);
    await resumed.resume();

    expect(resumed.getExpertTeamRuntime()!.memberByName('software-architect')).toBeUndefined();
    expect(resumed.getExpertTeamRuntime()!.hasActiveMembers()).toBe(false);
    await resumed.close();
  });

  it('restores the SendMessage tool when the persisted member tools omit it', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    let memberId: string;
    {
      const session = await makeSession(homedir, workDir);
      const main = await session.createMain();
      main.config.update({ modelAlias: MOCK_PROVIDER.model });
      await session.activateExpertTeam('test-team');
      const member = await session.createAgent(
        { type: 'sub' },
        {
          parentAgentId: 'main',
          profile: testTeam().memberProfiles['software-architect'],
        },
      );
      memberId = member.id;
      member.agent.config.update({ modelAlias: MOCK_PROVIDER.model });
      const runtime = session.getExpertTeamRuntime()!;
      runtime.registerMember('software-architect', memberId);
      runtime.markMemberStatus('software-architect', 'idle');
      await runtime.persist();
      // Simulate an older wire written before the member profile enabled the
      // mailbox tool. Restore must follow the current plugin profile.
      member.agent.tools.setActiveTools([]);
      await session.flushMetadata();
      await session.close();
    }

    const resumed = await makeSession(homedir, workDir);
    await resumed.resume();
    const member = await resumed.ensureAgentResumed(memberId!);

    expect(member.teamSelfName).toBe('software-architect');
    expect(
      member.tools.data().some((tool) => tool.name === 'SendMessage' && tool.active),
    ).toBe(true);
    expect(member.tools.loopTools.some((tool) => tool.name === 'SendMessage')).toBe(true);
    await resumed.close();
  });

  it('disposes the runtime when the session closes', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    const session = await makeSession(homedir, workDir);
    await session.createMain();
    await session.activateExpertTeam('test-team');
    const runtime = session.getExpertTeamRuntime()!;

    await session.close();

    await expect(
      runtime.send({
        type: 'message',
        from: 'team-lead',
        recipient: 'software-architect',
        summary: 'late',
        text: 'late message',
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'This expert-team runtime is no longer active.',
    });
  });

  it('clears the runtime state when the flag turns off across restarts', async () => {
    const workDir = await makeTempDir();
    const homedir = await makeTempDir();
    {
      const session = await makeSession(homedir, workDir);
      await session.createMain();
      await session.activateExpertTeam('test-team');
      await session.flushMetadata();
      await session.close();
    }

    const session = new Session({
      id: 'expert-team-test',
      kaos: testKaos.withCwd(workDir),
      homedir,
      rpc: sessionRpc(),
      expertTeams: [testTeam()],
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
    });
    await session.resume();
    expect(session.metadata.expertTeam).toBeUndefined();
    expect(session.metadata.expertTeamRuntime).toBeUndefined();
    expect(session.getExpertTeamRuntime()).toBeUndefined();
    await session.close();
  });
});
