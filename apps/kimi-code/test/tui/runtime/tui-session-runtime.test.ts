/**
 * Scenario: one active session-agent pair is exposed through neutral TUI ports.
 * Responsibilities: both runtime factories retain public identity and route
 * each capability through the selected runtime boundary.
 * Wiring: a small legacy or Klient-shaped facade is the only stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/tui-session-runtime.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  updateGoalQueueItem,
} from '#/tui/goal-queue-store';

import {
  createKlientTUISessionRuntime,
  createLegacyTUISessionRuntime,
} from '#/tui/runtime/tui-session-runtime';

vi.mock('#/tui/goal-queue-store', () => ({
  appendGoalQueueItem: vi.fn(),
  moveGoalQueueItem: vi.fn(),
  readGoalQueue: vi.fn(),
  removeGoalQueueItem: vi.fn(),
  restoreGoalQueueItem: vi.fn(),
  updateGoalQueueItem: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

function replaySource() {
  return {
    type: 'main' as const,
    config: {
      cwd: '/workspace',
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 128_000,
      },
      systemPrompt: 'Example system prompt',
    },
    context: {
      history: [],
      tokenCount: 0,
    },
    replay: [],
    permission: {
      mode: 'manual' as const,
      rules: [],
    },
    plan: null,
    usage: {},
    tools: [],
    tasks: [],
  };
}

describe('TUI session runtime (bound port composition)', () => {
  it('binds legacy ports to the selected session-agent identity', async () => {
    const setTitle = vi.fn(async (_title: string) => undefined);
    const setModel = vi.fn(async () => undefined);
    const getStatus = vi.fn(async () => ({ swarmMode: true }));
    const setSwarmMode = vi.fn(async () => undefined);
    const listExpertTeams = vi.fn(async () => [
      {
        pluginId: 'software-company',
        displayName: 'Software Company',
        leadAgentName: 'team-lead',
        memberAgentNames: ['engineer'],
        members: [],
        tags: [],
        quickPrompts: ['Review a change'],
      },
    ]);
    const getExpertTeamStatus = vi.fn(async () => ({
      pluginId: 'software-company',
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T01:00:00.000Z',
      members: [
        {
          name: 'engineer',
          agentId: 'agent-legacy-expert',
          status: 'running' as const,
        },
      ],
    }));
    const activateExpertTeam = vi.fn(async () => ({
      pluginId: 'software-company',
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T01:00:00.000Z',
    }));
    const deactivateExpertTeam = vi.fn(async () => undefined);
    const legacyPluginSummary = {
      id: 'legacy-plugin',
      displayName: 'Legacy Plugin',
      enabled: true,
      state: 'ok' as const,
      skillCount: 1,
      mcpServerCount: 1,
      enabledMcpServerCount: 1,
      hasErrors: false,
      source: 'local-path' as const,
    };
    const listPlugins = vi.fn(async () => [legacyPluginSummary]);
    const getPluginInfo = vi.fn(async () => ({
      ...legacyPluginSummary,
      root: '/plugins/legacy-plugin',
      installedAt: '2026-07-27T01:00:00.000Z',
      mcpServers: [],
      diagnostics: [],
    }));
    const installPlugin = vi.fn(async () => legacyPluginSummary);
    const setPluginEnabled = vi.fn(async () => undefined);
    const setPluginMcpServerEnabled = vi.fn(async () => undefined);
    const removePlugin = vi.fn(async () => undefined);
    const reloadPlugins = vi.fn(async () => ({
      added: ['legacy-plugin'],
      removed: [],
      errors: [],
    }));
    const init = vi.fn(async () => undefined);
    const cancelInit = vi.fn(async () => undefined);
    const startBtw = vi.fn(async () => 'agent-legacy-side');
    const listExtensionCommands = vi.fn(async () => [
      { extensionId: 'review', name: 'check', description: 'Review changes' },
    ]);
    const activateSkill = vi.fn(async () => undefined);
    const undoHistory = vi.fn(async () => undefined);
    const listWarnings = vi.fn(async () => [
      {
        code: 'secondary_model_unavailable',
        message: 'The configured secondary model is unavailable.',
        severity: 'warning' as const,
        runtimeOnly: true,
      },
    ]);
    const listMcpServers = vi.fn(async () => [
      {
        name: 'example-server',
        transport: 'stdio' as const,
        status: 'failed' as const,
        toolCount: 0,
        error: 'Connection failed.',
        runtimeOnly: true,
      },
    ]);
    const session = {
      id: 'session-1',
      summary: {
        id: 'session-1',
        workDir: '/workspace',
        additionalDirs: ['/workspace/shared'],
        createdAt: 1,
        updatedAt: 2,
      },
      workDir: '/workspace',
      setModel,
      getStatus,
      setSwarmMode,
      listExpertTeams,
      getExpertTeamStatus,
      activateExpertTeam,
      deactivateExpertTeam,
      listPlugins,
      getPluginInfo,
      installPlugin,
      setPluginEnabled,
      setPluginMcpServerEnabled,
      removePlugin,
      reloadPlugins,
      init,
      cancel: cancelInit,
      startBtw,
      getResumeState: vi.fn(() => ({
        agents: { worker: replaySource() },
      })),
      listExtensionCommands,
      activateSkill,
      undoHistory,
      getSessionWarnings: listWarnings,
      listMcpServers,
      reconnectMcpServer: vi.fn(async () => undefined),
      getMcpStartupMetrics: vi.fn(async () => ({ durationMs: 125 })),
    };
    const harness = {
      getSession: vi.fn(() => session),
      withInteractiveAgent: vi.fn((_agentId: string, operation: () => unknown) =>
        operation(),
      ),
      renameSession: vi.fn(({ title }: { title: string }) => setTitle(title)),
    };

    const runtime = createLegacyTUISessionRuntime(
      harness as unknown as Parameters<typeof createLegacyTUISessionRuntime>[0],
      session as unknown as Parameters<typeof createLegacyTUISessionRuntime>[1],
      'worker',
    );

    await runtime.lifecycle.setTitle('Renamed');
    await runtime.agent.setModel('model-b');
    const swarmActive = await runtime.swarm.isActive();
    await runtime.swarm.enter('task');
    await runtime.swarm.exit();
    const expertTeams = await runtime.expertTeam.list();
    const expertTeamStatus = await runtime.expertTeam.get();
    const activatedExpertTeam =
      await runtime.expertTeam.activate('software-company');
    await runtime.expertTeam.deactivate();
    await runtime.init.generateAgentsMd();
    await runtime.init.cancel();
    const btwAgentId = await runtime.btw.start();
    await runtime.agentEvents.readReplay();
    await runtime.extensionCommands.list();
    await runtime.skills.activate('review', 'src/main.ts');
    await runtime.context.undoHistory();
    const listedPlugins = await runtime.plugins.list();
    const loadedPluginInfo = await runtime.plugins.info('legacy-plugin');
    const installedPlugin =
      await runtime.plugins.install('./plugins/legacy-plugin');
    await runtime.plugins.setEnabled('legacy-plugin', false);
    await runtime.plugins.setMcpServerEnabled(
      'legacy-plugin',
      'example-server',
      true,
    );
    await runtime.plugins.remove('legacy-plugin');
    const reloadedPlugins = await runtime.plugins.reload();

    expect(await runtime.warnings.list()).toEqual([
      {
        code: 'secondary_model_unavailable',
        message: 'The configured secondary model is unavailable.',
        severity: 'warning',
      },
    ]);
    expect(await runtime.mcp.list()).toEqual([
      {
        name: 'example-server',
        transport: 'stdio',
        status: 'failed',
        toolCount: 0,
        error: 'Connection failed.',
      },
    ]);
    expect(await runtime.workspace.get()).toEqual({
      workDir: '/workspace',
      additionalDirs: ['/workspace/shared'],
    });
    expect(expertTeams).toEqual([
      {
        pluginId: 'software-company',
        pluginVersion: undefined,
        displayName: 'Software Company',
        description: undefined,
        leadAgentName: 'team-lead',
        memberAgentNames: ['engineer'],
        quickPrompts: ['Review a change'],
      },
    ]);
    expect(expertTeamStatus).toEqual({
      pluginId: 'software-company',
      pluginVersion: undefined,
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T01:00:00.000Z',
      members: [
        {
          name: 'engineer',
          agentId: 'agent-legacy-expert',
          status: 'running',
        },
      ],
    });
    expect(activatedExpertTeam).toEqual({
      pluginId: 'software-company',
      pluginVersion: undefined,
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T01:00:00.000Z',
      members: undefined,
    });
    expect({
      listed: listedPlugins.map((plugin) => plugin.id),
      info: loadedPluginInfo.id,
      installed: installedPlugin.id,
      reloaded: reloadedPlugins,
    }).toEqual({
      listed: ['legacy-plugin'],
      info: 'legacy-plugin',
      installed: 'legacy-plugin',
      reloaded: {
        added: ['legacy-plugin'],
        removed: [],
        errors: [],
      },
    });
    expect(swarmActive).toBe(true);
    expect(btwAgentId).toBe('agent-legacy-side');
    expect({ sessionId: runtime.sessionId, agentId: runtime.agentId }).toEqual({
      sessionId: 'session-1',
      agentId: 'worker',
    });
    expect(harness.renameSession).toHaveBeenCalledWith({
      id: 'session-1',
      title: 'Renamed',
    });
    expect(harness.getSession).toHaveBeenCalledWith('session-1');
    expect(harness.withInteractiveAgent).toHaveBeenCalledWith(
      'worker',
      expect.any(Function),
    );
    expect(setModel).toHaveBeenCalledWith('model-b');
    expect(getStatus).toHaveBeenCalledOnce();
    expect(setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(setSwarmMode).toHaveBeenCalledWith(false, 'manual');
    expect(listExpertTeams).toHaveBeenCalledOnce();
    expect(getExpertTeamStatus).toHaveBeenCalledOnce();
    expect(activateExpertTeam).toHaveBeenCalledWith('software-company');
    expect(deactivateExpertTeam).toHaveBeenCalledOnce();
    expect(listPlugins).toHaveBeenCalledOnce();
    expect(getPluginInfo).toHaveBeenCalledWith('legacy-plugin');
    expect(installPlugin).toHaveBeenCalledWith('./plugins/legacy-plugin');
    expect(setPluginEnabled).toHaveBeenCalledWith('legacy-plugin', false);
    expect(setPluginMcpServerEnabled).toHaveBeenCalledWith(
      'legacy-plugin',
      'example-server',
      true,
    );
    expect(removePlugin).toHaveBeenCalledWith('legacy-plugin');
    expect(reloadPlugins).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledOnce();
    expect(cancelInit).toHaveBeenCalledOnce();
    expect(startBtw).toHaveBeenCalledOnce();
    expect(session.getResumeState).toHaveBeenCalledOnce();
    expect(listExtensionCommands).toHaveBeenCalledOnce();
    expect(activateSkill).toHaveBeenCalledWith('review', 'src/main.ts');
    expect(undoHistory).toHaveBeenCalledOnce();
    expect(listWarnings).toHaveBeenCalledOnce();
    expect(listMcpServers).toHaveBeenCalledOnce();
  });

  it('binds Klient ports to the selected session-agent identity', async () => {
    const setTitle = vi.fn(async (_title: string) => undefined);
    const setModel = vi.fn(async () => ({ model: 'model-b' }));
    const getContext = vi.fn(async () => ({ history: [], tokenCount: 0 }));
    const readReplay = vi.fn(async () => replaySource());
    const isSwarmActive = vi.fn(async () => true);
    const enterSwarm = vi.fn(async () => undefined);
    const exitSwarm = vi.fn(async () => undefined);
    const listExpertTeams = vi.fn(async () => [
      {
        pluginId: 'software-company',
        displayName: 'Software Company',
        leadAgentName: 'team-lead',
        memberAgentNames: ['engineer'],
        members: [],
        tags: [],
        quickPrompts: ['Review a change'],
      },
    ]);
    const expertTeamSnapshot = {
      binding: {
        pluginId: 'software-company',
        displayName: 'Software Company',
        leadAgentName: 'team-lead',
        leadProfileName: 'expert:team-lead',
        memberAgentNames: ['engineer'],
        previousProfile: {
          thinkingLevel: 'high',
          cwd: '/workspace',
          systemPrompt: 'You are Kimi.',
        },
        activatedAt: '2026-07-27T02:00:00.000Z',
      },
      team: {
        id: 'team-1',
        name: 'Software Company',
        createdAt: '2026-07-27T02:01:00.000Z',
        members: [
          {
            name: 'engineer',
            agentId: 'agent-klient-expert',
            profileName: 'expert:engineer',
            status: 'running' as const,
            updatedAt: '2026-07-27T02:02:00.000Z',
          },
        ],
      },
    };
    const getExpertTeam = vi.fn(async () => expertTeamSnapshot);
    const activateExpertTeam = vi.fn(async () => expertTeamSnapshot);
    const deactivateExpertTeam = vi.fn(async () => undefined);
    const klientPluginSummary = {
      id: 'klient-plugin',
      displayName: 'Klient Plugin',
      enabled: true,
      state: 'ok' as const,
      skillCount: 2,
      mcpServerCount: 1,
      enabledMcpServerCount: 1,
      hasErrors: false,
      source: 'github' as const,
    };
    const listPlugins = vi.fn(async () => [klientPluginSummary]);
    const getPluginInfo = vi.fn(async () => ({
      ...klientPluginSummary,
      root: '/plugins/klient-plugin',
      installedAt: '2026-07-27T02:00:00.000Z',
      mcpServers: [],
      diagnostics: [],
    }));
    const installPlugin = vi.fn(async () => klientPluginSummary);
    const setPluginEnabled = vi.fn(async () => undefined);
    const setPluginMcpServerEnabled = vi.fn(async () => undefined);
    const removePlugin = vi.fn(async () => undefined);
    const reloadPlugins = vi.fn(async () => ({
      added: ['klient-plugin'],
      removed: [],
      errors: [],
    }));
    const generateAgentsMd = vi.fn(async () => undefined);
    const cancelInit = vi.fn(async () => undefined);
    const startBtw = vi.fn(async () => 'agent-klient-side');
    const listCommands = vi.fn(async () => [
      { extensionId: 'review', name: 'check', description: 'Review changes' },
    ]);
    const listSkills = vi.fn(async () => []);
    const activateSkill = vi.fn(async () => undefined);
    const compact = vi.fn(async () => true);
    const listWarnings = vi.fn(async () => [
      {
        code: 'secondary_model_unavailable',
        message: 'The configured secondary model is unavailable.',
        severity: 'error' as const,
        runtimeOnly: true,
      },
    ]);
    const listMcpServers = vi.fn(async () => [
      {
        name: 'example-server',
        transport: 'http' as const,
        status: 'connected' as const,
        toolCount: 2,
        runtimeOnly: true,
      },
    ]);
    const agent = {
      setModel,
      getContext,
      compact,
      swarm: {
        isActive: isSwarmActive,
        enter: enterSwarm,
        exit: exitSwarm,
      },
      mcp: {
        list: listMcpServers,
        reconnect: vi.fn(async () => undefined),
        initialLoadDurationMs: vi.fn(async () => 250),
      },
      skills: { activate: activateSkill },
      replay: { read: readReplay },
    };
    const session = {
      setTitle,
      agent: vi.fn(() => agent),
      expertTeam: {
        list: listExpertTeams,
        get: getExpertTeam,
        activate: activateExpertTeam,
        deactivate: deactivateExpertTeam,
      },
      extensions: { listCommands },
      skills: { list: listSkills },
      init: { generateAgentsMd, cancel: cancelInit },
      btw: { start: startBtw },
      warnings: { list: listWarnings },
      workspace: {
        get: vi.fn(async () => ({
          workDir: '/workspace',
          additionalDirs: ['/workspace/shared'],
        })),
      },
    };
    const klient = {
      global: {
        plugins: {
          list: listPlugins,
          info: getPluginInfo,
          install: installPlugin,
          setEnabled: setPluginEnabled,
          setMcpServerEnabled: setPluginMcpServerEnabled,
          remove: removePlugin,
          reload: reloadPlugins,
        },
      },
      session: vi.fn(() => session),
    };

    const runtime = createKlientTUISessionRuntime(
      klient as unknown as Parameters<typeof createKlientTUISessionRuntime>[0],
      'session-2',
      'worker',
    );

    await runtime.lifecycle.setTitle('Renamed');
    await runtime.agent.setModel('model-b');
    const swarmActive = await runtime.swarm.isActive();
    await runtime.swarm.enter('tool');
    await runtime.swarm.exit();
    const expertTeams = await runtime.expertTeam.list();
    const activeExpertTeam = await runtime.expertTeam.get();
    const activatedExpertTeam =
      await runtime.expertTeam.activate('software-company');
    await runtime.expertTeam.deactivate();
    await runtime.init.generateAgentsMd();
    await runtime.init.cancel();
    const btwAgentId = await runtime.btw.start();
    await runtime.agentEvents.readReplay();
    await runtime.extensionCommands.list();
    await runtime.skills.list();
    await runtime.skills.activate('review', 'src/main.ts');
    await runtime.context.compact();
    const listedPlugins = await runtime.plugins.list();
    const loadedPluginInfo = await runtime.plugins.info('klient-plugin');
    const installedPlugin =
      await runtime.plugins.install('./plugins/klient-plugin');
    await runtime.plugins.setEnabled('klient-plugin', false);
    await runtime.plugins.setMcpServerEnabled(
      'klient-plugin',
      'example-server',
      true,
    );
    await runtime.plugins.remove('klient-plugin');
    const reloadedPlugins = await runtime.plugins.reload();

    expect(await runtime.warnings.list()).toEqual([
      {
        code: 'secondary_model_unavailable',
        message: 'The configured secondary model is unavailable.',
        severity: 'error',
      },
    ]);
    expect(await runtime.mcp.list()).toEqual([
      {
        name: 'example-server',
        transport: 'http',
        status: 'connected',
        toolCount: 2,
        error: undefined,
      },
    ]);
    expect(await runtime.workspace.get()).toEqual({
      workDir: '/workspace',
      additionalDirs: ['/workspace/shared'],
    });
    expect(expertTeams).toEqual([
      {
        pluginId: 'software-company',
        pluginVersion: undefined,
        displayName: 'Software Company',
        description: undefined,
        leadAgentName: 'team-lead',
        memberAgentNames: ['engineer'],
        quickPrompts: ['Review a change'],
      },
    ]);
    expect(activeExpertTeam).toEqual({
      pluginId: 'software-company',
      pluginVersion: undefined,
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T02:00:00.000Z',
      members: [
        {
          name: 'engineer',
          agentId: 'agent-klient-expert',
          status: 'running',
        },
      ],
    });
    expect(activatedExpertTeam).toEqual({
      pluginId: 'software-company',
      pluginVersion: undefined,
      displayName: 'Software Company',
      leadAgentName: 'team-lead',
      activatedAt: '2026-07-27T02:00:00.000Z',
      members: [
        {
          name: 'engineer',
          agentId: 'agent-klient-expert',
          status: 'running',
        },
      ],
    });
    expect({
      listed: listedPlugins.map((plugin) => plugin.id),
      info: loadedPluginInfo.id,
      installed: installedPlugin.id,
      reloaded: reloadedPlugins,
    }).toEqual({
      listed: ['klient-plugin'],
      info: 'klient-plugin',
      installed: 'klient-plugin',
      reloaded: {
        added: ['klient-plugin'],
        removed: [],
        errors: [],
      },
    });
    expect(swarmActive).toBe(true);
    expect(btwAgentId).toBe('agent-klient-side');
    expect({ sessionId: runtime.sessionId, agentId: runtime.agentId }).toEqual({
      sessionId: 'session-2',
      agentId: 'worker',
    });
    expect(setTitle).toHaveBeenCalledWith('Renamed');
    expect(klient.session).toHaveBeenCalledWith('session-2');
    expect(session.agent).toHaveBeenCalledWith('worker');
    expect(setModel).toHaveBeenCalledWith('model-b');
    expect(readReplay).toHaveBeenCalledOnce();
    expect(isSwarmActive).toHaveBeenCalledOnce();
    expect(enterSwarm).toHaveBeenCalledWith('tool');
    expect(exitSwarm).toHaveBeenCalledOnce();
    expect(listExpertTeams).toHaveBeenCalledOnce();
    expect(getExpertTeam).toHaveBeenCalledOnce();
    expect(activateExpertTeam).toHaveBeenCalledWith('software-company');
    expect(deactivateExpertTeam).toHaveBeenCalledOnce();
    expect(listPlugins).toHaveBeenCalledOnce();
    expect(getPluginInfo).toHaveBeenCalledWith('klient-plugin');
    expect(installPlugin).toHaveBeenCalledWith('./plugins/klient-plugin');
    expect(setPluginEnabled).toHaveBeenCalledWith({
      id: 'klient-plugin',
      enabled: false,
    });
    expect(setPluginMcpServerEnabled).toHaveBeenCalledWith({
      id: 'klient-plugin',
      server: 'example-server',
      enabled: true,
    });
    expect(removePlugin).toHaveBeenCalledWith('klient-plugin');
    expect(reloadPlugins).toHaveBeenCalledOnce();
    expect(generateAgentsMd).toHaveBeenCalledOnce();
    expect(cancelInit).toHaveBeenCalledOnce();
    expect(startBtw).toHaveBeenCalledOnce();
    expect(listCommands).toHaveBeenCalledOnce();
    expect(listSkills).toHaveBeenCalledOnce();
    expect(activateSkill).toHaveBeenCalledWith({
      name: 'review',
      args: 'src/main.ts',
    });
    expect(compact).toHaveBeenCalledOnce();
    expect(listWarnings).toHaveBeenCalledOnce();
    expect(listMcpServers).toHaveBeenCalledOnce();
  });

  it('routes legacy goal queue read through the bound session', async () => {
    vi.mocked(readGoalQueue).mockResolvedValue({ goals: [] });
    const rig = legacyGoalQueueComposition();

    const result = await rig.runtime.goalQueue.read();

    expect(result).toEqual({ goals: [] });
    expect(readGoalQueue).toHaveBeenCalledWith(rig.session);
  });

  it('routes legacy goal queue append through the bound session', async () => {
    vi.mocked(appendGoalQueueItem).mockResolvedValue({ goals: [] });
    const rig = legacyGoalQueueComposition();

    const result = await rig.runtime.goalQueue.append({
      objective: 'Draft release notes',
    });

    expect(result).toEqual({ goals: [] });
    expect(appendGoalQueueItem).toHaveBeenCalledWith(rig.session, {
      objective: 'Draft release notes',
    });
  });

  it('routes legacy goal queue update through the bound session', async () => {
    vi.mocked(updateGoalQueueItem).mockResolvedValue({ goals: [] });
    const rig = legacyGoalQueueComposition();

    const result = await rig.runtime.goalQueue.update({
      goalId: 'queued-1',
      objective: 'Publish release notes',
    });

    expect(result).toEqual({ goals: [] });
    expect(updateGoalQueueItem).toHaveBeenCalledWith(rig.session, {
      goalId: 'queued-1',
      objective: 'Publish release notes',
    });
  });

  it('routes legacy goal queue remove through the bound session', async () => {
    vi.mocked(removeGoalQueueItem).mockResolvedValue({ goals: [] });
    const rig = legacyGoalQueueComposition();

    const result = await rig.runtime.goalQueue.remove({
      goalId: 'queued-1',
    });

    expect(result).toEqual({ goals: [] });
    expect(removeGoalQueueItem).toHaveBeenCalledWith(rig.session, {
      goalId: 'queued-1',
    });
  });

  it('routes legacy goal queue restore through the bound session', async () => {
    vi.mocked(restoreGoalQueueItem).mockResolvedValue({ goals: [] });
    const rig = legacyGoalQueueComposition();
    const goal = queuedGoal();

    const result = await rig.runtime.goalQueue.restore(goal);

    expect(result).toEqual({ goals: [] });
    expect(restoreGoalQueueItem).toHaveBeenCalledWith(rig.session, {
      id: 'queued-1',
      objective: 'Draft release notes',
      createdAt: '2026-07-27T08:00:00.000Z',
      updatedAt: '2026-07-27T08:00:00.000Z',
    });
  });

  it('routes legacy goal queue move through the bound session', async () => {
    vi.mocked(moveGoalQueueItem).mockResolvedValue({ goals: [] });
    const rig = legacyGoalQueueComposition();

    const result = await rig.runtime.goalQueue.move({
      goalId: 'queued-1',
      direction: 'down',
    });

    expect(result).toEqual({ goals: [] });
    expect(moveGoalQueueItem).toHaveBeenCalledWith(rig.session, {
      goalId: 'queued-1',
      direction: 'down',
    });
  });

  it('routes Klient goal queue read through the selected session facade', async () => {
    const rig = klientGoalQueueComposition();

    const result = await rig.runtime.goalQueue.read();

    expect(result).toEqual({ goals: [] });
    expect(rig.klient.session).toHaveBeenCalledWith('session-klient');
    expect(rig.goalQueue.read).toHaveBeenCalledOnce();
  });

  it('routes Klient goal queue append through the selected session facade', async () => {
    const rig = klientGoalQueueComposition();

    const result = await rig.runtime.goalQueue.append({
      objective: 'Draft release notes',
    });

    expect(result).toEqual({ goals: [] });
    expect(rig.goalQueue.append).toHaveBeenCalledWith({
      objective: 'Draft release notes',
    });
  });

  it('routes Klient goal queue update through the selected session facade', async () => {
    const rig = klientGoalQueueComposition();

    const result = await rig.runtime.goalQueue.update({
      goalId: 'queued-1',
      objective: 'Publish release notes',
    });

    expect(result).toEqual({ goals: [] });
    expect(rig.goalQueue.update).toHaveBeenCalledWith({
      goalId: 'queued-1',
      objective: 'Publish release notes',
    });
  });

  it('routes Klient goal queue remove through the selected session facade', async () => {
    const rig = klientGoalQueueComposition();

    const result = await rig.runtime.goalQueue.remove({
      goalId: 'queued-1',
    });

    expect(result).toEqual({ goals: [] });
    expect(rig.goalQueue.remove).toHaveBeenCalledWith({
      goalId: 'queued-1',
    });
  });

  it('routes Klient goal queue restore through the selected session facade', async () => {
    const rig = klientGoalQueueComposition();

    const result = await rig.runtime.goalQueue.restore(queuedGoal());

    expect(result).toEqual({ goals: [] });
    expect(rig.goalQueue.restore).toHaveBeenCalledWith({
      id: 'queued-1',
      objective: 'Draft release notes',
      createdAt: '2026-07-27T08:00:00.000Z',
      updatedAt: '2026-07-27T08:00:00.000Z',
    });
  });

  it('routes Klient goal queue move through the selected session facade', async () => {
    const rig = klientGoalQueueComposition();

    const result = await rig.runtime.goalQueue.move({
      goalId: 'queued-1',
      direction: 'down',
    });

    expect(result).toEqual({ goals: [] });
    expect(rig.goalQueue.move).toHaveBeenCalledWith({
      goalId: 'queued-1',
      direction: 'down',
    });
  });

  it('routes legacy context reads through the selected agent scope', async () => {
    const getContext = vi.fn(async () => ({
      history: [],
      tokenCount: 12,
    }));
    const session = {
      id: 'session-1',
      getContext,
    };
    const selectedAgentIds: string[] = [];
    const harness = {
      withInteractiveAgent<T>(agentId: string, operation: () => T): T {
        selectedAgentIds.push(agentId);
        return operation();
      },
    };
    const runtime = createLegacyTUISessionRuntime(
      harness as unknown as Parameters<typeof createLegacyTUISessionRuntime>[0],
      session as unknown as Parameters<typeof createLegacyTUISessionRuntime>[1],
      'worker',
    );

    const result = await runtime.contextView.read();

    expect(result).toEqual({ history: [], tokenCount: 12 });
    expect(getContext).toHaveBeenCalledOnce();
    expect(selectedAgentIds).toEqual(['worker']);
  });

  it('routes Klient context reads through the selected agent scope', async () => {
    const getContext = vi.fn(async () => ({
      history: [],
      tokenCount: 24,
    }));
    const agent = { getContext };
    const session = {
      agent: vi.fn((_agentId: string) => agent),
    };
    const klient = {
      global: { plugins: {} },
      session: vi.fn((_sessionId: string) => session),
    };
    const runtime = createKlientTUISessionRuntime(
      klient as unknown as Parameters<typeof createKlientTUISessionRuntime>[0],
      'session-2',
      'reviewer',
    );

    const result = await runtime.contextView.read();

    expect(result).toEqual({ history: [], tokenCount: 24 });
    expect(getContext).toHaveBeenCalledOnce();
    expect(session.agent).toHaveBeenCalledWith('reviewer');
  });
});

function queuedGoal() {
  return {
    id: 'queued-1',
    objective: 'Draft release notes',
    createdAt: '2026-07-27T08:00:00.000Z',
    updatedAt: '2026-07-27T08:00:00.000Z',
  };
}

function legacyGoalQueueComposition() {
  const session = {
    id: 'session-legacy',
    summary: { sessionDir: '/workspace/session-legacy' },
  };
  const harness = {
    getSession: vi.fn(() => session),
    withInteractiveAgent: vi.fn(
      (_agentId: string, operation: () => unknown) => operation(),
    ),
  };
  return {
    session,
    runtime: createLegacyTUISessionRuntime(
      harness as unknown as Parameters<
        typeof createLegacyTUISessionRuntime
      >[0],
      session as unknown as Parameters<
        typeof createLegacyTUISessionRuntime
      >[1],
      'worker',
    ),
  };
}

function klientGoalQueueComposition() {
  const goalQueue = {
    read: vi.fn(async () => ({ goals: [] })),
    append: vi.fn(async (_input: { readonly objective: string }) => ({
      goals: [],
    })),
    update: vi.fn(
      async (_input: {
        readonly goalId: string;
        readonly objective: string;
      }) => ({ goals: [] }),
    ),
    remove: vi.fn(async (_input: { readonly goalId: string }) => ({
      goals: [],
    })),
    restore: vi.fn(async (_goal: ReturnType<typeof queuedGoal>) => ({
      goals: [],
    })),
    move: vi.fn(
      async (_input: {
        readonly goalId: string;
        readonly direction: 'up' | 'down';
      }) => ({ goals: [] }),
    ),
  };
  const session = {
    agent: vi.fn(() => ({})),
    goalQueue,
  };
  const klient = {
    global: { plugins: {} },
    session: vi.fn((_sessionId: string) => session),
  };
  return {
    klient,
    goalQueue,
    runtime: createKlientTUISessionRuntime(
      klient as unknown as Parameters<
        typeof createKlientTUISessionRuntime
      >[0],
      'session-klient',
      'worker',
    ),
  };
}
