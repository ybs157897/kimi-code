/**
 * Scenario: interactive TUI session controls cross the runtime boundary.
 * Responsibilities: both adapters preserve neutral session identity and
 * agent-control semantics. The SDK harness or Klient facade is the one stubbed
 * external boundary in each rig.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-control-port.test.ts
 */

import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';
import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionControlPort } from '#/tui/runtime/klient-session-control-adapter';

const GOAL = {
  goalId: 'goal-1',
  objective: 'Ship the port',
  status: 'active' as const,
  turnsUsed: 2,
  tokensUsed: 120,
  wallClockMs: 500,
  budget: {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

const TASK = {
  taskId: 'task-1',
  kind: 'process' as const,
  description: 'Run checks',
  status: 'running' as const,
  detached: true,
  startedAt: 10,
  endedAt: null,
  command: 'pnpm test',
  pid: 42,
  exitCode: null,
};

const USAGE = {
  byModel: {
    'example-model': {
      inputOther: 100,
      output: 50,
      inputCacheRead: 20,
      inputCacheCreation: 10,
    },
  },
  currentTurn: {
    inputOther: 40,
    output: 20,
    inputCacheRead: 5,
    inputCacheCreation: 0,
  },
  total: {
    inputOther: 100,
    output: 50,
    inputCacheRead: 20,
    inputCacheCreation: 10,
  },
};

describe('Klient session control adapter (runtime-neutral controls)', () => {
  it('passes workspace ids resolved from the working directory into Klient listing', async () => {
    const rig = klientRig();
    const custom = { source: 'klient' };
    rig.sessions.list.mockResolvedValue({
      items: [klientSummary({ cwd: '/workspace-alias', custom })],
    });

    const identities = await rig.port.sessions.list({ workDir: '/workspace' });

    expect(rig.workspaces.list).toHaveBeenCalledOnce();
    expect(rig.sessions.list).toHaveBeenCalledWith({
      workspaceIds: ['workspace-1'],
      includeArchived: undefined,
      cursor: undefined,
    });
    expect(identities[0]?.workDir).toBe('/workspace-alias');
    expect(identities[0]?.metadata).toEqual({ source: 'klient' });
    expect(identities[0]?.metadata).not.toBe(custom);
  });

  it('collects every page from Klient session listing', async () => {
    const rig = klientRig();
    rig.sessions.list
      .mockResolvedValueOnce({
        items: [klientSummary({ id: 'session-1' })],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [klientSummary({ id: 'session-2' })],
      });

    const identities = await rig.port.sessions.list();

    expect(rig.sessions.list).toHaveBeenNthCalledWith(1, {
      workspaceIds: undefined,
      includeArchived: undefined,
      cursor: undefined,
    });
    expect(rig.sessions.list).toHaveBeenNthCalledWith(2, {
      workspaceIds: undefined,
      includeArchived: undefined,
      cursor: 'page-2',
    });
    expect(identities.map((identity) => identity.id)).toEqual([
      'session-1',
      'session-2',
    ]);
  });

  it('uses exact Klient session lookup when a session id is provided', async () => {
    const rig = klientRig();

    const identities = await rig.port.sessions.list({ sessionId: 'session-1' });

    expect(rig.sessions.get).toHaveBeenCalledWith('session-1');
    expect(rig.sessions.list).not.toHaveBeenCalled();
    expect(identities[0]?.id).toBe('session-1');
  });

  it('creates a Klient session with the main-agent binding, applying startup modes', async () => {
    const rig = klientRig();

    const identity = await rig.port.sessions.create({
      workDir: '/workspace',
      model: 'example-model',
      thinking: 'high',
      permission: 'auto',
      planMode: true,
      additionalDirs: ['/extra'],
    });

    expect(rig.sessions.create).toHaveBeenCalledWith({
      workDir: '/workspace',
      additionalDirs: ['/extra'],
      mainAgentBinding: {
        profile: 'agent',
        model: 'example-model',
        thinking: 'high',
        strictThinking: true,
      },
    });
    expect(rig.agent.setPermission).toHaveBeenCalledWith('auto');
    expect(rig.agent.enterPlan).toHaveBeenCalledOnce();
    expect(identity.id).toBe('session-1');
  });

  it('returns undefined when the requested Klient session does not exist', async () => {
    const rig = klientRig();
    rig.sessions.get.mockResolvedValue(undefined);

    const identity = await rig.port.sessions.resume({ id: 'missing' });

    expect(identity).toBeUndefined();
    expect(rig.session.restore).not.toHaveBeenCalled();
  });

  it('restores an existing Klient session, returning its live identity', async () => {
    const rig = klientRig();
    const custom = { source: 'klient' };
    rig.session.get.mockResolvedValue(klientSummary({ custom }));

    const identity = await rig.port.sessions.resume({ id: 'session-1' });

    expect(rig.session.restore).toHaveBeenCalledOnce();
    expect(rig.session.get).toHaveBeenCalledOnce();
    expect(identity).toMatchObject({
      id: 'session-1',
      workDir: '/workspace',
      metadata: { source: 'klient' },
    });
    expect(identity?.metadata).not.toBe(custom);
  });

  it('adds every additional directory in order after Klient restore succeeds', async () => {
    const rig = klientRig();
    const operations: string[] = [];
    rig.session.restore.mockImplementation(async () => {
      operations.push('restore');
      return true;
    });
    rig.session.workspace.addAdditionalDir.mockImplementation(async ({ path }) => {
      operations.push(`add:${path}`);
      return {
        projectRoot: '/workspace',
        configPath: '/workspace/.kimi/config.toml',
        additionalDirs: [],
        persisted: false,
      };
    });
    rig.session.get.mockImplementation(async () => {
      operations.push('get');
      return klientSummary();
    });

    await rig.port.sessions.resume({
      id: 'session-1',
      additionalDirs: ['/extra-b', '/extra-a', '/extra-b'],
    });

    expect(operations).toEqual([
      'restore',
      'add:/extra-b',
      'add:/extra-a',
      'add:/extra-b',
      'get',
    ]);
    expect(rig.session.workspace.addAdditionalDir.mock.calls).toEqual([
      [{ path: '/extra-b', persist: false }],
      [{ path: '/extra-a', persist: false }],
      [{ path: '/extra-b', persist: false }],
    ]);
  });

  it('does not add directories when Klient restore returns false', async () => {
    const rig = klientRig();
    rig.session.restore.mockResolvedValue(false);

    const identity = await rig.port.sessions.resume({
      id: 'session-1',
      additionalDirs: ['/extra'],
    });

    expect(identity).toBeUndefined();
    expect(rig.session.workspace.addAdditionalDir).not.toHaveBeenCalled();
    expect(rig.session.get).not.toHaveBeenCalled();
  });

  it('gets a Klient session identity through the session facade', async () => {
    const rig = klientRig();

    const identity = await rig.port.session('session-1').getIdentity();

    expect(rig.session.get).toHaveBeenCalledOnce();
    expect(identity).toMatchObject({ id: 'session-1', workDir: '/workspace' });
  });

  it('closes a Klient session through the session facade', async () => {
    const rig = klientRig();

    await rig.port.session('session-1').close();

    expect(rig.session.close).toHaveBeenCalledOnce();
  });

  it('sets a Klient session title through the session facade', async () => {
    const rig = klientRig();

    await rig.port.session('session-1').setTitle('Renamed session');

    expect(rig.session.setTitle).toHaveBeenCalledWith('Renamed session');
  });

  it('forks a Klient session through the session facade', async () => {
    const rig = klientRig();

    const identity = await rig.port
      .session('session-1')
      .fork({ title: 'Forked session' });

    expect(rig.session.fork).toHaveBeenCalledWith({ title: 'Forked session' });
    expect(identity.id).toBe('fork-1');
  });

  it('normalizes text before routing Klient turn controls to the main agent', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    await agent.prompt('hello');
    await agent.steer([{ type: 'text', text: 'focus on tests' }]);
    await agent.cancel();

    expect(rig.agent.prompt).toHaveBeenCalledWith({
      input: [{ type: 'text', text: 'hello' }],
    });
    expect(rig.agent.steer).toHaveBeenCalledWith({
      input: [{ type: 'text', text: 'focus on tests' }],
    });
    expect(rig.agent.cancel).toHaveBeenCalledWith();
  });

  it('routes Klient shell controls through the agent facade', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    const result = await agent.runShellCommand('pnpm test', 'command-1');
    await agent.cancelShellCommand('command-1');

    expect(rig.agent.runShellCommand).toHaveBeenCalledWith({
      command: 'pnpm test',
      commandId: 'command-1',
    });
    expect(rig.agent.cancelShellCommand).toHaveBeenCalledWith({
      commandId: 'command-1',
    });
    expect(result).toEqual({ stdout: 'ok', stderr: '' });
  });

  it('composes the Klient agent runtime status into the neutral shape', async () => {
    const rig = klientRig();

    const status = await rig.port.agent('session-1').getStatus();

    expect(status).toEqual({
      model: 'example-model',
      thinkingEffort: 'high',
      permission: 'manual',
      planMode: true,
      contextTokens: 250,
      maxContextTokens: 1000,
      contextUsage: 0.25,
      usage: USAGE,
    });
  });

  it('reports zero Klient context usage when the model has no context limit', async () => {
    const rig = klientRig();
    rig.agent.profile.get.mockResolvedValue(klientProfile(0));

    const status = await rig.port.agent('session-1').getStatus();

    expect(status.contextUsage).toBe(0);
  });

  it('reads and updates the model through the Klient agent facade', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    expect(await agent.getModel()).toBe('example-model');
    await agent.setModel('next-model');

    expect(rig.agent.setModel).toHaveBeenCalledWith('next-model');
  });

  it('updates thinking through the Klient profile facade', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    expect(await agent.getThinking()).toBe('high');
    await agent.setThinking('max');

    expect(rig.agent.profile.setThinking).toHaveBeenCalledWith('max');
  });

  it('updates permission through the Klient agent facade', async () => {
    const rig = klientRig();

    await rig.port.agent('session-1').setPermission('yolo');

    expect(rig.agent.setPermission).toHaveBeenCalledWith('yolo');
  });

  it('maps Klient plan disablement to cancellation while keeping clear explicit', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    expect(await agent.getPlan()).toEqual({
      id: 'plan-1',
      content: '# Plan',
      path: '/plan.md',
    });
    await agent.setPlanMode(false);
    await agent.clearPlan();

    expect(rig.agent.cancelPlan).toHaveBeenCalledOnce();
    expect(rig.agent.clearPlan).toHaveBeenCalledOnce();
  });

  it('maps the Klient goal lifecycle onto the neutral goal controls', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    expect(await agent.getGoal()).toEqual(GOAL);
    await agent.createGoal({ objective: 'Ship the port', replace: true });
    await agent.pauseGoal();
    await agent.resumeGoal();
    await agent.cancelGoal();

    expect(rig.agent.goal.create).toHaveBeenCalledWith({
      objective: 'Ship the port',
      replace: true,
    });
    expect(rig.agent.goal.pause).toHaveBeenCalledWith();
    expect(rig.agent.goal.resume).toHaveBeenCalledWith();
    expect(rig.agent.goal.cancel).toHaveBeenCalledWith();
  });

  it('maps Klient task queries and controls onto the agent facade', async () => {
    const rig = klientRig();
    const agent = rig.port.agent('session-1');

    const tasks = await agent.listTasks({ activeOnly: false, limit: 10 });
    const output = await agent.getTaskOutput('task-1', 4000);
    await agent.stopTask('task-1', 'User initiated stop');

    expect(tasks).toEqual([TASK]);
    expect(output).toBe('task output');
    expect(rig.agent.getTasks).toHaveBeenCalledWith({
      activeOnly: false,
      limit: 10,
    });
    expect(rig.agent.getTaskOutput).toHaveBeenCalledWith({
      taskId: 'task-1',
      tail: 4000,
    });
    expect(rig.agent.stopTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      reason: 'User initiated stop',
    });
  });

  it('returns the detached task through the requested Klient agent scope', async () => {
    const rig = klientRig();

    const task = await rig.port.agent('session-1', 'worker').detachTask('task-1');

    expect(task).toEqual(TASK);
    expect(rig.session.agent).toHaveBeenCalledWith('worker');
    expect(rig.agent.detachTask).toHaveBeenCalledWith({ taskId: 'task-1' });
  });

  it('returns undefined when the Klient task cannot be detached', async () => {
    const rig = klientRig();
    rig.agent.detachTask.mockResolvedValueOnce(undefined);

    const task = await rig.port.agent('session-1').detachTask('missing');

    expect(task).toBeUndefined();
  });
});

function klientSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    cwd: '/workspace',
    title: 'Example session',
    lastPrompt: 'hello',
    createdAt: 10,
    updatedAt: 20,
    archived: false,
    custom: { source: 'klient' },
    ...overrides,
  };
}

function klientProfile(maxContextTokens = 1000) {
  return {
    profileName: 'coder',
    modelAlias: 'example-model',
    modelCapabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: maxContextTokens,
      max_input_tokens: 800,
    },
    thinkingLevel: 'high',
    systemPrompt: '',
    cwd: '/workspace',
  };
}

function klientRig() {
  const agent = {
    prompt: vi.fn(async () => ({ turn_id: 1 })),
    steer: vi.fn(async () => ({ turn_id: 1 })),
    cancel: vi.fn(async () => {}),
    runShellCommand: vi.fn(async () => ({ stdout: 'ok', stderr: '' })),
    cancelShellCommand: vi.fn(async () => {}),
    getModel: vi.fn(async () => 'example-model'),
    setModel: vi.fn(async (model: string) => ({ model })),
    getPermission: vi.fn(async () => 'manual' as const),
    setPermission: vi.fn(async () => {}),
    getUsage: vi.fn(async () => USAGE),
    getContext: vi.fn(async () => ({ history: [], tokenCount: 250 })),
    getPlan: vi.fn(async () => ({ id: 'plan-1', content: '# Plan', path: '/plan.md' })),
    enterPlan: vi.fn(async () => {}),
    cancelPlan: vi.fn(async () => {}),
    clearPlan: vi.fn(async () => {}),
    profile: {
      get: vi.fn(async () => klientProfile()),
      bind: vi.fn(async () => {}),
      setThinking: vi.fn(async () => {}),
    },
    goal: {
      get: vi.fn(async () => GOAL),
      create: vi.fn(async () => GOAL),
      pause: vi.fn(async () => GOAL),
      resume: vi.fn(async () => GOAL),
      cancel: vi.fn(async () => GOAL),
    },
    getTasks: vi.fn(async () => [TASK]),
    detachTask: vi.fn<
      (input: { taskId: string }) => Promise<typeof TASK | undefined>
    >(async () => TASK),
    getTaskOutput: vi.fn(async () => 'task output'),
    stopTask: vi.fn(async () => {}),
  };
  const session = {
    restore: vi.fn(async () => true),
    get: vi.fn(async () => klientSummary()),
    close: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    fork: vi.fn(async () => klientSummary({ id: 'fork-1' })),
    workspace: {
      addAdditionalDir: vi.fn(
        async (_input: { path: string; persist?: boolean }) => ({
          projectRoot: '/workspace',
          configPath: '/workspace/.kimi/config.toml',
          additionalDirs: [],
          persisted: false,
        }),
      ),
    },
    agent: vi.fn(() => agent),
  };
  const sessions = {
    list: vi.fn(
      async (): Promise<{
        items: ReturnType<typeof klientSummary>[];
        nextCursor?: string;
      }> => ({ items: [klientSummary()] }),
    ),
    get: vi.fn<
      (id: string) => Promise<ReturnType<typeof klientSummary> | undefined>
    >(async () => klientSummary()),
    create: vi.fn(async () => klientSummary()),
  };
  const workspaces = {
    list: vi.fn(async () => [
      {
        id: 'workspace-1',
        root: '/workspace',
        name: 'workspace',
      },
    ]),
  };
  const klient = {
    global: { sessions, workspaces },
    session: vi.fn(() => session),
  };
  return {
    agent,
    session,
    sessions,
    workspaces,
    klient,
    port: createKlientSessionControlPort(
      klient as unknown as KimiV2Runtime['klient'],
    ),
  };
}
