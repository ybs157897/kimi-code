/**
 * Scenario: transport-agnostic Klient facade routing and event delivery.
 * Responsibilities: reshape facade calls, validate contracts, and forward
 * namespaced events. FakeChannel is the only transport boundary stub.
 * Run: pnpm --filter @moonshot-ai/klient exec vitest run test/facade.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../src/core/channel.js';
import { createKlientFromChannel } from '../src/core/klient.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records calls, replays scripted results, and captures listen subscriptions. */
class FakeChannel implements KlientChannel {
  readonly calls: Array<{ scope: ScopeRef; service: string; method: string; args: unknown[] }> = [];
  readonly subscriptions: Array<{ source: EventSourceRef; dispose: ReturnType<typeof vi.fn> }> =
    [];
  result: unknown;
  /** Keyed `${service}.${method}` result overrides. */
  readonly results = new Map<string, unknown>();
  private readonly handlers = new Map<number, (data: unknown) => void>();
  private nextSub = 0;

  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ scope, service, method, args });
    const key = `${service}.${method}`;
    return Promise.resolve(this.results.has(key) ? this.results.get(key) : this.result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_scope: ScopeRef, _service: string, _method: string, _args: unknown[]): AsyncIterableIterator<unknown> {
    // stub — streaming is not exercised in facade tests
  }

  listen(_scope: ScopeRef, source: EventSourceRef, handler: (data: unknown) => void): IDisposable {
    const id = this.nextSub;
    this.nextSub += 1;
    this.handlers.set(id, handler);
    const dispose = vi.fn(() => {
      this.handlers.delete(id);
    });
    this.subscriptions.push({ source, dispose });
    return { dispose };
  }

  /** Push a raw payload into the Nth subscription (0-based). */
  emit(index: number, data: unknown): void {
    this.handlers.get(index)?.(data);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SUMMARY = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

const MANAGED_USAGE = {
  kind: 'ok' as const,
  summary: {
    label: 'Weekly limit',
    used: 25,
    limit: 100,
    resetHint: '3d',
  },
  limits: [],
  extraUsage: {
    balanceCents: 900,
    totalCents: 1_000,
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimitCents: 2_000,
    monthlyUsedCents: 100,
    currency: 'USD',
  },
};

const SUBMIT_FEEDBACK_BODY = {
  session_id: 'session-example',
  content: 'Example feedback.',
  version: '1.2.3-example',
  os: 'example-os',
  model: null,
};

const CREATE_FEEDBACK_UPLOAD_BODY = {
  file_hash: 'sha256-example',
  file_name: 'feedback.zip',
  file_size: 1_024,
  feedback_id: 42,
};

const COMPLETE_FEEDBACK_UPLOAD_BODY = {
  upload_id: 7,
  parts: [{ part_number: 1, etag: 'etag-example' }],
};

const SESSION_EXPORT_PAYLOAD = {
  sessionId: 'session-example',
  outputPath: '/tmp/session-example.zip',
  includeGlobalLog: true,
  includeDesktopLog: true,
  version: '1.2.3-example',
  installSource: 'example-installer',
  shellEnv: {
    term: 'xterm-example',
    termProgram: 'terminal-example',
    termProgramVersion: '1.0.0',
    multiplexer: 'multiplexer-example',
    shell: '/bin/example-shell',
  },
};

const SESSION_EXPORT_RESULT = {
  zipPath: '/tmp/session-example.zip',
  entries: ['manifest.json'],
  sessionDir: '/tmp/session-example',
  manifest: {
    sessionId: 'session-example',
    exportedAt: '2026-07-27T00:00:00.000Z',
    kimiCodeVersion: '1.2.3-example',
    wireProtocolVersion: '1',
    os: 'example-os example-arch',
    nodejsVersion: '24.15.0',
    title: 'Example session',
    installSource: 'example-installer',
    shellEnv: SESSION_EXPORT_PAYLOAD.shellEnv,
  },
};

const GOAL = {
  goalId: 'g1',
  objective: 'finish the migration',
  status: 'active' as const,
  turnsUsed: 0,
  tokensUsed: 0,
  wallClockMs: 0,
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

const UPCOMING_GOAL = {
  id: 'queued-goal-1',
  objective: 'finish the queued migration',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
};

const GOAL_QUEUE = {
  goals: [UPCOMING_GOAL],
};

const PROFILE = {
  cwd: '/workspace',
  modelAlias: 'stub',
  modelCapabilities: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 32_000,
  },
  profileName: 'agent',
  thinkingLevel: 'off',
  systemPrompt: 'You are an agent.',
};

const REPLAY_SNAPSHOT = {
  type: 'main' as const,
  config: {
    cwd: '/workspace',
    modelAlias: 'stub',
    modelCapabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 32_000,
    },
    profileName: 'agent',
    thinkingLevel: 'off',
    systemPrompt: 'You are an agent.',
  },
  context: { history: [], tokenCount: 0 },
  replay: [],
  permission: { mode: 'manual' as const, rules: [] },
  plan: null,
  swarmMode: false,
  usage: {},
  tools: [],
  tasks: [],
  todos: [],
};

const SKILL = {
  name: 'review',
  description: 'Review the current change.',
  path: '/workspace/.agents/skills/review/SKILL.md',
  source: 'project' as const,
  type: 'prompt',
};

describe('facade routing', () => {
  it('creates a main agent with its profile bound before activation', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionLifecycleService.create', { id: 's1', kind: 1 });
    channel.results.set('sessionMetadata.read', SUMMARY);

    await klient.global.sessions.create({
      workDir: '/workspace',
      mainAgentBinding: {
        profile: 'reviewer',
        model: 'stub',
        thinking: 'off',
      },
    });

    expect(channel.calls[0]).toEqual({
      scope: {},
      service: 'sessionLifecycleService',
      method: 'create',
      args: [
        {
          workDir: '/workspace',
          additionalDirs: undefined,
          mainAgentBinding: {
            profile: 'reviewer',
            model: 'stub',
            thinking: 'off',
          },
        },
      ],
    });
  });

  it('reshapes single-object params into positional wire args', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.result = { id: 'w1', root: '/x', name: 'n', createdAt: 1, lastOpenedAt: 2 };
    await klient.global.workspaces.createOrTouch({ root: '/x', name: 'n' });
    expect(channel.calls[0]).toMatchObject({
      service: 'workspaceService',
      method: 'createOrTouch',
      args: ['/x', 'n'],
    });

    channel.result = undefined; // void output
    await klient.global.plugins.setMcpServerEnabled({ id: 'p', server: 's', enabled: true });
    expect(channel.calls[1]).toMatchObject({
      service: 'pluginService',
      method: 'setPluginMcpServerEnabled',
      args: [{ id: 'p', server: 's', enabled: true }],
    });

    channel.results.set('oauthService.status', { loggedIn: false });
    await klient.global.auth.status();
    expect(channel.calls[2]).toMatchObject({
      service: 'oauthService',
      method: 'status',
      args: [undefined],
    });

    channel.result = {
      binding: {
        pluginId: 'delivery-experts',
        displayName: 'Delivery Experts',
        leadAgentName: 'delivery-lead',
        leadProfileName: 'expert:delivery-experts:delivery-lead',
        memberAgentNames: ['architect'],
        previousProfile: {
          profileName: 'agent',
          thinkingLevel: 'medium',
          cwd: '/workspace',
          systemPrompt: 'default agent prompt',
        },
        activatedAt: '2026-07-26T00:00:00.000Z',
      },
    };
    await klient.session('s1').expertTeam.activate('delivery-experts');
    expect(channel.calls[3]).toMatchObject({
      scope: { sessionId: 's1' },
      service: 'sessionExpertTeamService',
      method: 'activate',
      args: ['delivery-experts'],
    });

    channel.result = [];
    await klient.session('s1').extensions.listCommands();
    expect(channel.calls[4]).toMatchObject({
      scope: { sessionId: 's1' },
      service: 'sessionExtensionService',
      method: 'listCommands',
      args: [],
    });

    channel.result = false;
    await klient.session('s1').agent('main').extensions.activateCommand({
      extensionId: 'example',
      name: 'hello',
      args: 'world',
    });
    expect(channel.calls[5]).toMatchObject({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentExtensionService',
      method: 'activateCommand',
      args: [{ extensionId: 'example', name: 'hello', args: 'world' }],
    });
  });

  it('returns managed usage unchanged through the fixed app scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = MANAGED_USAGE;

    await expect(
      klient.global.auth.getManagedUsage('provider-example'),
    ).resolves.toEqual(MANAGED_USAGE);

    expect(channel.calls).toEqual([
      {
        scope: {},
        service: 'oauthService',
        method: 'getManagedUsage',
        args: ['provider-example'],
      },
    ]);
  });

  it('routes feedback submission unchanged through the fixed app scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const result = { kind: 'ok' as const, feedbackId: 42 };
    channel.result = result;

    await expect(
      klient.global.auth.submitFeedback(SUBMIT_FEEDBACK_BODY, 'provider-example'),
    ).resolves.toEqual(result);

    expect(channel.calls).toEqual([
      {
        scope: {},
        service: 'oauthService',
        method: 'submitFeedback',
        args: [SUBMIT_FEEDBACK_BODY, 'provider-example'],
      },
    ]);
  });

  it('routes feedback upload creation unchanged through the fixed app scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const result = {
      kind: 'ok' as const,
      upload_id: 7,
      parts: [
        {
          part_number: 1,
          url: 'https://example.test/upload/part-1',
          method: 'PUT',
          size: 1_024,
        },
      ],
    };
    channel.result = result;

    await expect(
      klient.global.auth.createFeedbackUploadUrl(
        CREATE_FEEDBACK_UPLOAD_BODY,
        'provider-example',
      ),
    ).resolves.toEqual(result);

    expect(channel.calls).toEqual([
      {
        scope: {},
        service: 'oauthService',
        method: 'createFeedbackUploadUrl',
        args: [CREATE_FEEDBACK_UPLOAD_BODY, 'provider-example'],
      },
    ]);
  });

  it('routes feedback upload completion unchanged through the fixed app scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const result = { kind: 'ok' as const };
    channel.result = result;

    await expect(
      klient.global.auth.completeFeedbackUpload(
        COMPLETE_FEEDBACK_UPLOAD_BODY,
        'provider-example',
      ),
    ).resolves.toEqual(result);

    expect(channel.calls).toEqual([
      {
        scope: {},
        service: 'oauthService',
        method: 'completeFeedbackUpload',
        args: [COMPLETE_FEEDBACK_UPLOAD_BODY, 'provider-example'],
      },
    ]);
  });

  it('returns the session export result through the fixed app scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = SESSION_EXPORT_RESULT;

    await expect(
      klient.global.sessionExport.export(SESSION_EXPORT_PAYLOAD),
    ).resolves.toEqual(SESSION_EXPORT_RESULT);

    expect(channel.calls).toEqual([
      {
        scope: {},
        service: 'sessionExportService',
        method: 'export',
        args: [SESSION_EXPORT_PAYLOAD],
      },
    ]);
  });

  it('routes goal, cron, and profile calls through their narrow services', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const session = klient.session('s1');
    const agent = session.agent('main');

    channel.result = [];
    await session.cron.list();
    channel.result = null;
    await session.cron.getNextFireTime();

    channel.result = { goal: GOAL };
    await expect(agent.goal.get()).resolves.toEqual(GOAL);
    channel.result = GOAL;
    await agent.goal.create({ objective: GOAL.objective });
    await agent.goal.pause();
    await agent.goal.resume({ continueIfPaused: true });
    await agent.goal.cancel({ reason: 'done' });

    channel.result = undefined;
    await agent.profile.bind({ profile: 'agent', model: 'stub', cwd: '/workspace' });
    channel.result = PROFILE;
    await expect(agent.profile.get()).resolves.toEqual(PROFILE);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionCronService',
        method: 'list',
        args: [],
      },
      {
        scope: { sessionId: 's1' },
        service: 'sessionCronService',
        method: 'getNextFireTime',
        args: [],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentGoalService',
        method: 'getGoal',
        args: [],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentGoalService',
        method: 'createGoal',
        args: [{ objective: 'finish the migration' }],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentGoalService',
        method: 'pauseGoal',
        args: [{}],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentGoalService',
        method: 'resumeGoal',
        args: [{ continueIfPaused: true }],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentGoalService',
        method: 'cancelGoal',
        args: [{ reason: 'done' }],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentProfileService',
        method: 'bind',
        args: [{ profile: 'agent', model: 'stub', cwd: '/workspace' }],
      },
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentProfileService',
        method: 'data',
        args: [],
      },
    ]);
  });

  it('routes a scoped agent thinking change to the profile service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').profile.setThinking('high');

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentProfileService',
        method: 'setThinking',
        args: ['high'],
      },
    ]);
  });

  it('reads the replay snapshot through the fixed agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = REPLAY_SNAPSHOT;

    await expect(
      klient.session('s1').agent('agent-example').replay.read(),
    ).resolves.toEqual(REPLAY_SNAPSHOT);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'agent-example' },
        service: 'agentReplayView',
        method: 'read',
        args: [],
      },
    ]);
  });

  it('reads the goal queue through the fixed session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = GOAL_QUEUE;

    await expect(klient.session('s1').goalQueue.read()).resolves.toEqual(
      GOAL_QUEUE,
    );

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionGoalQueueService',
        method: 'read',
        args: [],
      },
    ]);
  });

  it('appends a goal through the fixed session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = GOAL_QUEUE;

    await expect(
      klient
        .session('s1')
        .goalQueue.append({ objective: 'finish the queued migration' }),
    ).resolves.toEqual(GOAL_QUEUE);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionGoalQueueService',
        method: 'append',
        args: [{ objective: 'finish the queued migration' }],
      },
    ]);
  });

  it('updates a goal through the fixed session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = GOAL_QUEUE;

    await expect(
      klient.session('s1').goalQueue.update({
        goalId: 'queued-goal-1',
        objective: 'finish the queued migration',
      }),
    ).resolves.toEqual(GOAL_QUEUE);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionGoalQueueService',
        method: 'update',
        args: [
          {
            goalId: 'queued-goal-1',
            objective: 'finish the queued migration',
          },
        ],
      },
    ]);
  });

  it('removes a goal through the fixed session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = GOAL_QUEUE;

    await expect(
      klient.session('s1').goalQueue.remove({ goalId: 'queued-goal-1' }),
    ).resolves.toEqual(GOAL_QUEUE);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionGoalQueueService',
        method: 'remove',
        args: [{ goalId: 'queued-goal-1' }],
      },
    ]);
  });

  it('restores a goal through the fixed session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = GOAL_QUEUE;

    await expect(
      klient.session('s1').goalQueue.restore(UPCOMING_GOAL),
    ).resolves.toEqual(GOAL_QUEUE);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionGoalQueueService',
        method: 'restore',
        args: [UPCOMING_GOAL],
      },
    ]);
  });

  it('moves a goal through the fixed session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = GOAL_QUEUE;

    await expect(
      klient
        .session('s1')
        .goalQueue.move({ goalId: 'queued-goal-1', direction: 'down' }),
    ).resolves.toEqual(GOAL_QUEUE);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionGoalQueueService',
        method: 'move',
        args: [{ goalId: 'queued-goal-1', direction: 'down' }],
      },
    ]);
  });

  it('returns the session skill catalog through the session facade', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = [SKILL];

    await expect(klient.session('s1').skills.list()).resolves.toEqual([SKILL]);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionSkillCatalog',
        method: 'listSkills',
        args: [],
      },
    ]);
  });

  it('routes session skill reload with no arguments to the scoped catalog', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').skills.reload();

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionSkillCatalog',
        method: 'reload',
        args: [],
      },
    ]);
  });

  it('normalizes the session startup warning to a warning list', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const warning = {
      code: 'secondary-model-invalid',
      message: 'The configured secondary model is unavailable.',
    };
    channel.result = warning;

    await expect(klient.session('s1').warnings.list()).resolves.toEqual([warning]);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionSecondaryModelWarningService',
        method: 'getSecondaryModelWarning',
        args: [],
      },
    ]);
  });

  it('returns an empty warning list when the session has no startup warning', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await expect(klient.session('s1').warnings.list()).resolves.toEqual([]);
  });

  it('reads swarm activity through the scoped swarm service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = true;

    await expect(klient.session('s1').agent('main').swarm.isActive()).resolves.toBe(true);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentSwarmService',
        method: 'isActive',
        args: [],
      },
    ]);
  });

  it('enters swarm mode through the scoped swarm service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').swarm.enter('task');

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentSwarmService',
        method: 'enter',
        args: ['task'],
      },
    ]);
  });

  it('exits swarm mode through the scoped swarm service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').swarm.exit();

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentSwarmService',
        method: 'exit',
        args: [],
      },
    ]);
  });

  it('generates AGENTS.md through the scoped session init service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').init.generateAgentsMd();

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionInitService',
        method: 'generateAgentsMd',
        args: [],
      },
    ]);
  });

  it('cancels session init through the scoped init service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await expect(klient.session('s1').init.cancel()).resolves.toBeUndefined();

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionInitService',
        method: 'cancelInit',
        args: [],
      },
    ]);
  });

  it('starts a side agent through the scoped BTW service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'agent-side';

    await expect(klient.session('s1').btw.start()).resolves.toBe('agent-side');

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1' },
        service: 'sessionBtwService',
        method: 'start',
        args: [],
      },
    ]);
  });

  it('activates a skill through the scoped agent facade', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').skills.activate({
      name: 'review',
      args: 'focus on lifecycle boundaries',
    });

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentRPCService',
        method: 'activateSkill',
        args: [{ name: 'review', args: 'focus on lifecycle boundaries' }],
      },
    ]);
  });

  it('activates a plugin command through the scoped agent RPC facade', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').activatePluginCommand({
      pluginId: 'example-plugin',
      commandName: 'review',
      args: 'focus on boundaries',
    });

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentRPCService',
        method: 'activatePluginCommand',
        args: [
          {
            pluginId: 'example-plugin',
            commandName: 'review',
            args: 'focus on boundaries',
          },
        ],
      },
    ]);
  });

  it('starts manual compaction through the scoped full-compaction service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = true;

    await expect(
      klient.session('s1').agent('main').compact({ instruction: 'Keep decisions.' }),
    ).resolves.toBe(true);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentFullCompactionService',
        method: 'begin',
        args: [{ source: 'manual', instruction: 'Keep decisions.' }],
      },
    ]);
  });

  it('cancels compaction through the scoped agent RPC service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').cancelCompaction();

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentRPCService',
        method: 'cancelCompaction',
        args: [{}],
      },
    ]);
  });

  it('undoes one turn by default through the scoped agent RPC service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 1;

    await expect(klient.session('s1').agent('main').undoHistory()).resolves.toBe(1);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentRPCService',
        method: 'undoHistory',
        args: [{ count: 1 }],
      },
    ]);
  });

  it('returns detached task info when routing through the scoped task service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const detachedTask = {
      kind: 'process' as const,
      taskId: 'task-1',
      command: 'sleep 60',
      pid: 1234,
      exitCode: null,
      description: 'Foreground command',
      status: 'running' as const,
      detached: true,
      startedAt: 1,
      endedAt: null,
    };
    channel.result = detachedTask;

    await expect(
      klient.session('s1').agent('main').detachTask({ taskId: 'task-1' }),
    ).resolves.toEqual(detachedTask);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentTaskService',
        method: 'detach',
        args: ['task-1'],
      },
    ]);
  });

  it('returns MCP servers from the scoped agent MCP service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const servers = [
      {
        name: 'example-server',
        transport: 'stdio' as const,
        status: 'failed' as const,
        toolCount: 0,
        error: 'Connection failed.',
      },
    ];
    channel.result = servers;

    await expect(klient.session('s1').agent('main').mcp.list()).resolves.toEqual(servers);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentMcpService',
        method: 'list',
        args: [],
      },
    ]);
  });

  it('reconnects a named server through the scoped agent MCP service', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.session('s1').agent('main').mcp.reconnect('example-server');

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentMcpService',
        method: 'reconnect',
        args: ['example-server'],
      },
    ]);
  });

  it('returns the scoped agent MCP initial-load duration', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 125;

    await expect(
      klient.session('s1').agent('main').mcp.initialLoadDurationMs(),
    ).resolves.toBe(125);

    expect(channel.calls).toEqual([
      {
        scope: { sessionId: 's1', agentId: 'main' },
        service: 'agentMcpService',
        method: 'initialLoadDurationMs',
        args: [],
      },
    ]);
  });

  it('exposes the prompt auth-readiness gate', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = undefined;

    await klient.global.auth.ensureReady('k2');

    expect(channel.calls).toEqual([
      {
        scope: {},
        service: 'authSummaryService',
        method: 'ensureReady',
        args: ['k2'],
      },
    ]);
  });

  it('env() fans out property reads and merges them', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    const env = await klient.global.env();
    expect(env.platform).toBe('v');
    expect(env.logsDir).toBe('v');
    expect(channel.calls).toHaveLength(12);
    expect(channel.calls.every((call) => call.service === 'bootstrapService')).toBe(true);
  });

  it('env() resolves once and serves repeats from the cache', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    await klient.global.env();
    expect(channel.calls).toHaveLength(12);

    const again = await klient.global.env();
    expect(again.platform).toBe('v');
    expect(channel.calls).toHaveLength(12);
  });
});

describe('contract validation', () => {
  it('rejects invalid input before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toHaveLength(0);
  });

  it('rejects drifted output payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = { id: 's1' }; // missing required SessionSummary fields
    await expect(klient.global.sessions.get('s1')).rejects.toBeInstanceOf(KlientValidationError);
  });

  it('passes valid payloads through and returns parsed output', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = SUMMARY;
    await expect(klient.global.sessions.get('s1')).resolves.toEqual(SUMMARY);
  });

  it('validate:false skips both directions', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    channel.result = { anything: true };
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).resolves.toEqual({ anything: true });
  });
});

describe('event hub', () => {
  it('forwards live rendering events from the agent stream when payloads are valid', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: string[] = [];
    const events = klient.session('s1').agent('main').events;
    for (const name of [
      'turn.step.started',
      'turn.step.retrying',
      'turn.step.interrupted',
      'turn.step.completed',
      'hook.result',
      'tool.call.delta',
      'tool.progress',
      'shell.output',
      'shell.started',
      'notice',
    ] as const) {
      events.on(name, (event) => {
        seen.push(event.type);
      });
    }

    channel.emit(0, { type: 'turn.step.started', turnId: 1, step: 1 });
    channel.emit(0, {
      type: 'turn.step.retrying',
      turnId: 1,
      step: 1,
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 250,
      errorName: 'OverloadedError',
      errorMessage: 'try later',
    });
    channel.emit(0, {
      type: 'turn.step.interrupted',
      turnId: 1,
      step: 2,
      reason: 'cancelled',
    });
    channel.emit(0, {
      type: 'turn.step.completed',
      turnId: 1,
      step: 2,
      finishReason: 'stop',
      providerFinishReason: 'completed',
    });
    channel.emit(0, {
      type: 'hook.result',
      turnId: 1,
      hookEvent: 'PostToolUse',
      content: 'done',
    });
    channel.emit(0, {
      type: 'tool.call.delta',
      turnId: 1,
      toolCallId: 'call_1',
      name: 'Read',
      argumentsPart: '{}',
    });
    channel.emit(0, {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'call_1',
      update: { kind: 'progress', text: 'reading' },
    });
    channel.emit(0, {
      type: 'shell.output',
      commandId: 'shell-1',
      taskId: 'task-1',
      update: { kind: 'stdout', text: 'done' },
    });
    channel.emit(0, {
      type: 'shell.started',
      commandId: 'shell-1',
      taskId: 'task-1',
    });
    channel.emit(0, {
      type: 'notice',
      message: 'Extension completed.',
      code: 'extension.completed',
    });
    await tick();

    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });
    expect(seen).toEqual([
      'turn.step.started',
      'turn.step.retrying',
      'turn.step.interrupted',
      'turn.step.completed',
      'hook.result',
      'tool.call.delta',
      'tool.progress',
      'shell.output',
      'shell.started',
      'notice',
    ]);
  });

  it('forwards state-transition events from the agent stream when payloads are valid', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: string[] = [];
    const events = klient.session('s1').agent('main').events;
    for (const name of [
      'goal.updated',
      'skill.activated',
      'plugin_command.activated',
      'compaction.started',
      'compaction.blocked',
      'compaction.cancelled',
      'compaction.completed',
    ] as const) {
      events.on(name, (event) => {
        seen.push(event.type);
      });
    }

    channel.emit(0, {
      type: 'goal.updated',
      snapshot: null,
      change: { kind: 'lifecycle', status: 'paused' },
    });
    channel.emit(0, {
      type: 'skill.activated',
      activationId: 'activation-1',
      skillName: 'review',
      trigger: 'user-slash',
      skillSource: 'project',
    });
    channel.emit(0, {
      type: 'plugin_command.activated',
      activationId: 'activation-2',
      pluginId: 'example-plugin',
      commandName: 'inspect',
      trigger: 'user-slash',
    });
    channel.emit(0, {
      type: 'compaction.started',
      trigger: 'manual',
      instruction: 'Keep the decisions.',
    });
    channel.emit(0, { type: 'compaction.blocked', turnId: 1 });
    channel.emit(0, { type: 'compaction.cancelled' });
    channel.emit(0, {
      type: 'compaction.completed',
      result: {
        summary: 'Decisions retained.',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 40,
      },
    });
    await tick();

    expect(seen).toEqual([
      'goal.updated',
      'skill.activated',
      'plugin_command.activated',
      'compaction.started',
      'compaction.blocked',
      'compaction.cancelled',
      'compaction.completed',
    ]);
  });

  it('forwards auxiliary-work events from the agent stream when payloads are valid', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: string[] = [];
    const events = klient.session('s1').agent('main').events;
    for (const name of [
      'subagent.spawned',
      'subagent.started',
      'subagent.suspended',
      'subagent.completed',
      'subagent.failed',
      'task.started',
      'task.terminated',
      'cron.fired',
      'mcp.server.status',
      'tool.list.updated',
    ] as const) {
      events.on(name, (event) => {
        seen.push(event.type);
      });
    }

    channel.emit(0, {
      type: 'subagent.spawned',
      subagentId: 'agent-1',
      subagentName: 'reviewer',
      parentToolCallId: 'call-1',
      runInBackground: false,
    });
    channel.emit(0, { type: 'subagent.started', subagentId: 'agent-1' });
    channel.emit(0, {
      type: 'subagent.suspended',
      subagentId: 'agent-1',
      reason: 'waiting',
    });
    channel.emit(0, {
      type: 'subagent.completed',
      subagentId: 'agent-1',
      resultSummary: 'Reviewed.',
    });
    channel.emit(0, {
      type: 'subagent.failed',
      subagentId: 'agent-2',
      error: 'Unavailable.',
    });
    const task = {
      taskId: 'task-1',
      kind: 'agent',
      description: 'Review',
      status: 'running',
      startedAt: 1,
      endedAt: null,
    };
    channel.emit(0, { type: 'task.started', info: task });
    channel.emit(0, {
      type: 'task.terminated',
      info: { ...task, status: 'completed', endedAt: 2 },
    });
    channel.emit(0, {
      type: 'cron.fired',
      origin: {
        kind: 'cron_job',
        jobId: 'cron-1',
        cron: '0 * * * *',
        recurring: true,
        coalescedCount: 0,
        stale: false,
      },
      prompt: 'Run the hourly check.',
    });
    channel.emit(0, {
      type: 'mcp.server.status',
      server: {
        name: 'example-server',
        transport: 'stdio',
        status: 'connected',
        toolCount: 2,
      },
    });
    channel.emit(0, {
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: 'example-server',
    });
    await tick();

    expect(seen).toEqual([
      'subagent.spawned',
      'subagent.started',
      'subagent.suspended',
      'subagent.completed',
      'subagent.failed',
      'task.started',
      'task.terminated',
      'cron.fired',
      'mcp.server.status',
      'tool.list.updated',
    ]);
  });

  it('maps public names to emitter sources and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
        errors.push(error);
      });

    klient.events.on('kosong.providers.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    channel.emit(0, { added: ['p1'], removed: [], changed: [] });
    channel.emit(0, { added: 'not-an-array' });
    await tick();
    expect(seen).toEqual([{ added: ['p1'], removed: [], changed: [] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });

  it('shares one bus subscription across bus-derived events and filters by type', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const archived: unknown[] = [];
    const catalog: unknown[] = [];

    const subA = klient.events.on('session.archived', (event) => archived.push(event));
    const subB = klient.events.on('kosong.changed', (event) => catalog.push(event));
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    channel.emit(0, { type: 'event.session.archived', payload: { sessionId: 's1' } });
    channel.emit(0, { type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] } });
    channel.emit(0, { type: 'unrelated.type', payload: {} });
    await tick();
    expect(archived).toEqual([{ sessionId: 's1' }]);
    expect(catalog).toEqual([{ changed: [], unchanged: [], failed: [] }]);

    subA.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    subB.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the emitter subscription when the last listener detaches', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const a = klient.events.on('config.changed', () => undefined);
    const b = klient.events.on('config.changed', () => undefined);
    expect(channel.subscriptions).toHaveLength(1);
    a.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    b.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});
