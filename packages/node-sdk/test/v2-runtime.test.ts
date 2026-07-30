/**
 * Scenario: the v2 SDK Runtime owns engine and host telemetry resources.
 * Responsibility: expose only Klient plus narrow host lifecycle facades, and
 * flush those resources when the Runtime closes.
 * Run: pnpm --filter @moonshot-ai/kimi-code-sdk exec vitest run test/v2-runtime.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import { LocalWorkspaceFileSystemFactory } from '@moonshot-ai/agent-core-v2/app/workspaceFs/localWorkspaceFileSystemFactoryService';
import { eventSchema } from '@moonshot-ai/protocol';
import type {
  IWorkspaceFileSystemFactory,
  WorkspaceFileSystemContext,
} from '@moonshot-ai/agent-core-v2/os/interface/workspaceFileSystem';

import { createKimiHarness, SDKRpcClient, SDKRpcClientBase } from '../src/index';
import {
  getV2CompatibilityMethodReport,
  projectCronTasks,
  projectAgentEventPayload,
  projectExpertTeamChangedEvent,
  projectExpertTeamStatus,
  projectModelCatalogChangedEvent,
} from '../src/sdk-rpc-client';
import { createKimiV2Runtime } from '../src/v2';

describe('KimiV2Runtime', () => {
  const homes: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      homes.splice(0).map((home) =>
        rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }),
      ),
    );
  });

  it('owns the engine lifecycle behind a Klient boundary', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const runtime = await createKimiV2Runtime({
      homeDir,
      clientVersion: 'test',
    });

    const env = await runtime.klient.global.env();
    expect(env.homeDir).toBe(homeDir);
    expect(env.clientVersion).toBe('test');

    const session = await runtime.klient.global.sessions.create({
      workDir: process.cwd(),
      title: 'v2 runtime',
    });
    await expect(runtime.klient.session(session.id).get()).resolves.toMatchObject({
      id: session.id,
      title: 'v2 runtime',
    });

    await runtime.close();
    await runtime.close();
  });

  it('keeps non-serializable workspace filesystem overrides on the hosted lifecycle seam', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-hosted-workspace-'));
    const additionalDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-hosted-extra-'));
    homes.push(homeDir, workDir, additionalDir);
    const runtime = await createKimiV2Runtime({ homeDir });
    const localFactory = new LocalWorkspaceFileSystemFactory(new HostFileSystem());
    const create = vi.fn((context: WorkspaceFileSystemContext) =>
      localFactory.create(context),
    );
    const hostedFactory: IWorkspaceFileSystemFactory = {
      _serviceBrand: undefined,
      create,
    };

    const created = await runtime.hostedSessions.create(
      {
        sessionId: 'hosted-session',
        workDir,
        additionalDirs: [additionalDir],
      },
      { workspaceFileSystemFactory: hostedFactory },
    );
    expect(created.id).toBe('hosted-session');
    expect(create).toHaveBeenLastCalledWith({
      sessionId: 'hosted-session',
      workDir,
      additionalDirs: [additionalDir],
    });

    await runtime.klient.session(created.id).close();
    const resumed = await runtime.hostedSessions.resume(
      created.id,
      { additionalDirs: [additionalDir] },
      { workspaceFileSystemFactory: hostedFactory },
    );
    expect(resumed).toEqual({ id: created.id });
    expect(create).toHaveBeenCalledTimes(2);

    await runtime.close();
  });

  it('persists image originals through the narrow local-media capability', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const runtime = await createKimiV2Runtime({ homeDir });
    const session = await runtime.klient.global.sessions.create({
      workDir: process.cwd(),
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const path = await runtime.localMedia.persistOriginalImage({
      bytes,
      mimeType: 'image/png',
      sessionId: session.id,
    });

    expect(path).not.toBeNull();
    expect(path).toContain('media-originals');
    await expect(readFile(path!)).resolves.toEqual(Buffer.from(bytes));
    await runtime.close();
  });

  it('applies print defaults through host options', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const runtime = await createKimiV2Runtime({
      homeDir,
      mode: 'print',
      skillDirs: ['/workspace/skills'],
      agentFiles: ['/workspace/agents/reviewer.md'],
      requestHeaders: { 'User-Agent': 'example.test' },
    });

    await expect(runtime.klient.global.config.get('task')).resolves.toMatchObject({
      bashTaskTimeoutS: 0,
    });
    await expect(runtime.klient.global.config.get('loopControl')).resolves.toMatchObject({
      maxStepsPerTurn: 0,
    });
    await expect(runtime.klient.global.config.get('subagent')).resolves.toMatchObject({
      timeoutMs: 0,
    });

    await runtime.close();
  });

  it('resolves the profile contributed by an explicit agent file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const agentFile = join(homeDir, 'reviewer.md');
    await writeFile(
      agentFile,
      [
        '---',
        'name: code-reviewer',
        'description: Reviews code.',
        '---',
        '',
        'Review the requested code.',
        '',
      ].join('\n'),
    );
    const runtime = await createKimiV2Runtime({ homeDir });

    await expect(
      runtime.agentFiles.resolveProfileName({
        file: './reviewer.md',
        workDir: homeDir,
      }),
    ).resolves.toBe('code-reviewer');

    await runtime.close();
  });

  it('activates a namespaced extension command through the root SDK facade', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-extension-home-'));
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-extension-work-'));
    homes.push(homeDir, workDir);
    const extensionDir = join(workDir, '.kimi-code', 'extensions');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, 'example.ts'),
      [
        'export default (api) => {',
        "  api.registerCommand('hello', {",
        "    description: 'hello',",
        '    prompt: (args) => `hello ${args}`,',
        '  });',
        '};',
      ].join('\n'),
      'utf-8',
    );
    const harness = createKimiHarness({ homeDir });

    try {
      const session = await harness.createSession({
        id: 'session-extension-command',
        workDir,
      });
      await expect(session.listExtensionCommands()).resolves.toContainEqual({
        extensionId: 'example',
        name: 'hello',
        description: 'hello',
      });
      await expect(
        session.activateExtensionCommand('example:hello', 'world'),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('creates the main agent with its profile bound before first materialization', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const runtime = await createKimiV2Runtime({ homeDir });
    const modelId = '__runtime_profile_binding__';
    await runtime.klient.global.kosong.addProvider({
      id: modelId,
      model: 'stub-model',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:1',
      auth: { method: 'api-key', apiKey: 'YOUR_API_KEY' },
      maxContextSize: 32_000,
      capabilities: { tool_use: true },
    });

    const session = await runtime.klient.global.sessions.create({
      workDir: process.cwd(),
      mainAgentBinding: {
        profile: 'agent',
        model: modelId,
        thinking: 'off',
      },
    });

    await expect(runtime.klient.session(session.id).agent('main').profile.get()).resolves.toMatchObject({
      profileName: 'agent',
      modelAlias: modelId,
      thinkingLevel: 'off',
    });

    await runtime.close();
  });

  it('flushes first-launch and exit events with the current host context', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const getAccessToken = vi.fn(async () => 'access-test');
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = await createKimiV2Runtime({
      homeDir,
      clientVersion: '1.2.3-test',
      telemetry: {
        enabled: true,
        deviceId: 'device-test',
        appName: 'kimi-code',
        uiMode: 'print',
        model: 'k2-initial',
        getAccessToken,
      },
    });

    runtime.telemetry.setContext({
      sessionId: 'ses-test',
      model: 'k2-selected',
    });
    runtime.telemetry.track('first_launch');
    runtime.telemetry.track('exit', { duration_ms: 42 });
    await runtime.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(request!.body as string) as {
      readonly events: readonly Record<string, unknown>[];
    };
    expect(payload.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'kfc_first_launch',
          session_id: 'ses-test',
          context_app_name: 'kimi-code',
          context_ui_mode: 'print',
          context_model: 'k2-selected',
        }),
        expect.objectContaining({
          event: 'kfc_exit',
          session_id: 'ses-test',
          property_duration_ms: 42,
        }),
      ]),
    );
  });

  it('forwards custom events with readonly primitive properties through the host facade', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = await createKimiV2Runtime({
      homeDir,
      telemetry: {
        enabled: true,
        deviceId: 'device-test',
        appName: 'kimi-code',
      },
    });
    const properties = {
      view: 'chat',
      item_count: 3,
      restored: false,
      error_type: null,
    } as const;

    runtime.telemetry.track('tui_rendered', properties);
    await runtime.close();

    const [, request] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(request!.body as string) as {
      readonly events: readonly Record<string, unknown>[];
    };
    expect(payload.events[0]).toMatchObject({
      event: 'kfc_tui_rendered',
      property_view: 'chat',
      property_item_count: 3,
      property_restored: false,
      property_error_type: null,
    });
  });

  it('clears nullable host context before the next telemetry event', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-runtime-'));
    homes.push(homeDir);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runtime = await createKimiV2Runtime({
      homeDir,
      telemetry: {
        enabled: true,
        deviceId: 'device-test',
        appName: 'kimi-code',
        model: 'k2-initial',
      },
    });
    runtime.telemetry.setContext({
      sessionId: 'ses-test',
      model: 'k2-selected',
    });

    runtime.telemetry.setContext({
      sessionId: null,
      model: null,
    });
    runtime.telemetry.track('tui_context_cleared');
    await runtime.close();

    const [, request] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(request!.body as string) as {
      readonly events: readonly Record<string, unknown>[];
    };
    expect(payload.events[0]?.['session_id']).toBeNull();
    expect(payload.events[0]?.['context_model']).toBeUndefined();
  });
});

describe('v2-backed root KimiHarness compatibility', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) =>
        rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }),
      ),
    );
  });

  it('derives the exact mapped and unmapped root SDK methods from concrete overrides', () => {
    const nonRpcAsyncMethods = new Set([
      'createSessionWithKaos',
      'enterSwarmMode',
      'exitSwarmMode',
      'resumeSessionWithKaos',
      'requestApproval',
      'requestQuestion',
      'toolCall',
    ]);
    const baseMethods = asyncPrototypeMethodNames(SDKRpcClientBase.prototype)
      .filter((name) => !nonRpcAsyncMethods.has(name))
      .toSorted();
    const concreteOverrides = new Set(Object.getOwnPropertyNames(SDKRpcClient.prototype));
    const report = getV2CompatibilityMethodReport();

    expect(report.mapped).toEqual(
      baseMethods.filter((name) => concreteOverrides.has(name)),
    );
    expect(report.unmapped).toEqual(
      baseMethods.filter((name) => !concreteOverrides.has(name)),
    );
    expect(report.mapped).toHaveLength(83);
    expect(report.unmapped).toEqual([]);
  });

  it('projects v2 expert-team runtime phases into the root status contract', () => {
    expect(
      projectExpertTeamStatus({
        binding: {
          pluginId: 'review',
          displayName: 'Review',
          leadAgentName: 'lead',
          leadProfileName: 'lead',
          memberAgentNames: ['reviewer', 'tester', 'writer'],
          previousProfile: {
            profileName: 'agent',
            thinkingLevel: 'off',
            cwd: '/workspace',
            systemPrompt: 'Review.',
          },
          activatedAt: '2026-07-29T12:00:00.000Z',
        },
        team: {
          id: 'team-review',
          name: 'Review',
          createdAt: '2026-07-29T12:00:00.000Z',
          members: [
            {
              name: 'reviewer',
              agentId: 'agent-reviewer',
              profileName: 'reviewer',
              status: 'spawning',
              updatedAt: '2026-07-29T12:00:00.000Z',
            },
            {
              name: 'tester',
              agentId: 'agent-tester',
              profileName: 'tester',
              status: 'running',
              updatedAt: '2026-07-29T12:00:00.000Z',
            },
            {
              name: 'writer',
              agentId: 'agent-writer',
              profileName: 'writer',
              status: 'failed',
              updatedAt: '2026-07-29T12:00:00.000Z',
            },
          ],
        },
      }),
    ).toEqual({
      members: [
        {
          agentId: 'agent-reviewer',
          phase: { phase: 'waiting', stepDescription: 'reviewer' },
        },
        {
          agentId: 'agent-tester',
          phase: { phase: 'active', stepDescription: 'tester' },
        },
        {
          agentId: 'agent-writer',
          phase: { phase: 'completed', stepDescription: 'writer' },
        },
      ],
    });
  });

  it('projects each v2 cron task with its own next-run timestamp', async () => {
    const nextFire = vi.fn(async (taskId: string) =>
      taskId === 'cron-active' ? 1_785_000_000_000 : null,
    );

    await expect(
      projectCronTasks(
        [
          {
            id: 'cron-active',
            cron: '*/5 * * * *',
            prompt: 'active',
            createdAt: 1,
          },
          {
            id: 'cron-inactive',
            cron: '0 0 1 1 *',
            prompt: 'inactive',
            createdAt: 2,
          },
        ],
        nextFire,
      ),
    ).resolves.toEqual({
      tasks: [
        {
          id: 'cron-active',
          name: 'cron-active',
          expression: '*/5 * * * *',
          status: 'scheduled',
          nextRunAt: 1_785_000_000_000,
        },
        {
          id: 'cron-inactive',
          name: 'cron-inactive',
          expression: '0 0 1 1 *',
          status: 'inactive',
          nextRunAt: undefined,
        },
      ],
    });
    expect(nextFire).toHaveBeenCalledTimes(2);
  });

  it('projects v2 audio steer content before validating the public event', () => {
    const projected = projectAgentEventPayload({
      type: 'prompt.steered',
      activePromptId: 'prompt-active',
      promptIds: ['prompt-active'],
      content: [
        {
          type: 'audio_url',
          audioUrl: { url: 'https://example.test/steer.mp3' },
        },
      ],
      steeredAt: '2026-07-29T12:00:00.000Z',
    });

    expect(
      eventSchema.parse({
        ...projected,
        sessionId: 'session-audio-steer',
        agentId: 'main',
      }),
    ).toMatchObject({
      type: 'prompt.steered',
      content: [
        {
          type: 'text',
          text: '[audio:https://example.test/steer.mp3]',
        },
      ],
    });
  });

  it('projects a v2 shell completion through the public event schema', () => {
    const projected = projectAgentEventPayload({
      type: 'shell.completed',
      commandId: 'command-complete',
      taskId: 'task-complete',
      isError: false,
    });

    expect(
      eventSchema.parse({
        ...projected,
        sessionId: 'session-shell-complete',
        agentId: 'main',
      }),
    ).toEqual({
      type: 'shell.completed',
      sessionId: 'session-shell-complete',
      agentId: 'main',
      commandId: 'command-complete',
      taskId: 'task-complete',
      isError: false,
    });
  });

  it('projects v2 expert-team member phases through the public event schema', () => {
    const projected = projectExpertTeamChangedEvent('session-expert-team', {
      binding: {
        pluginId: 'plugin-review',
        pluginVersion: '1.0.0',
        displayName: 'Review Team',
        leadAgentName: 'lead',
        leadProfileName: 'review-lead',
        memberAgentNames: ['reviewer', 'tester', 'writer'],
        previousProfile: {
          thinkingLevel: 'off',
          cwd: '/workspace',
          systemPrompt: 'Review the change.',
        },
        activatedAt: '2026-07-29T12:00:00.000Z',
      },
      team: {
        id: 'team-review',
        name: 'Review Team',
        createdAt: '2026-07-29T12:00:00.000Z',
        members: [
          {
            name: 'reviewer',
            agentId: 'agent-reviewer',
            profileName: 'reviewer',
            status: 'spawning',
            updatedAt: '2026-07-29T12:00:00.000Z',
          },
          {
            name: 'tester',
            agentId: 'agent-tester',
            profileName: 'tester',
            status: 'running',
            updatedAt: '2026-07-29T12:00:00.000Z',
          },
          {
            name: 'writer',
            agentId: 'agent-writer',
            profileName: 'writer',
            status: 'completed',
            updatedAt: '2026-07-29T12:00:00.000Z',
          },
        ],
      },
    });

    expect(eventSchema.parse(projected)).toMatchObject({
      type: 'expert_team.updated',
      sessionId: 'session-expert-team',
      status: {
        pluginId: 'plugin-review',
        members: [
          { name: 'reviewer', status: 'not_started' },
          { name: 'tester', status: 'running' },
          { name: 'writer', status: 'idle' },
        ],
      },
    });
  });

  it('projects v2 model-catalog refreshes as a global public event', () => {
    const projected = projectModelCatalogChangedEvent({
      changed: [
        {
          provider_id: 'provider-example',
          provider_name: 'Example Provider',
          added: 2,
          removed: 1,
        },
      ],
      unchanged: ['provider-stable'],
      failed: [{ provider: 'provider-failed', reason: 'offline' }],
    });

    expect(eventSchema.parse(projected)).toEqual({
      type: 'event.model_catalog.changed',
      sessionId: '__global__',
      agentId: 'main',
      changed: [
        {
          provider_id: 'provider-example',
          provider_name: 'Example Provider',
          added: 2,
          removed: 1,
        },
      ],
      unchanged: ['provider-stable'],
      failed: [{ provider: 'provider-failed', reason: 'offline' }],
    });
  });

  it('gets config and completes create, list, close, and resume without hanging', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-compat-'));
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-workspace-'));
    homes.push(homeDir, workDir);
    const harness = createKimiHarness({ homeDir });

    try {
      await expect(harness.getConfig()).resolves.toMatchObject({
        providers: {},
      });

      const created = await harness.createSession({
        workDir,
        permission: 'manual',
      });
      expect(created.summary).toMatchObject({
        id: created.id,
        workDir,
      });
      await expect(harness.listSessions({ workDir })).resolves.toEqual([
        expect.objectContaining({ id: created.id, workDir }),
      ]);

      await created.close();
      await expect(harness.listSessions({ workDir })).resolves.toEqual([
        expect.objectContaining({ id: created.id, workDir }),
      ]);

      const resumed = await harness.resumeSession({ id: created.id });
      expect(resumed.getResumeState()?.agents['main']).toBeDefined();
    } finally {
      await Promise.all([harness.close(), harness.close()]);
    }
  });

  it('closes safely when concurrent callers race runtime startup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-compat-close-'));
    homes.push(homeDir);
    const harness = createKimiHarness({ homeDir });

    await expect(
      Promise.all([harness.close(), harness.close(), harness.close()]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('preserves explicit session ids and metadata through lifecycle creation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-compat-id-'));
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-id-workspace-'));
    homes.push(homeDir, workDir);
    const harness = createKimiHarness({ homeDir });

    try {
      const session = await harness.createSession({
        id: 'session-explicit',
        workDir,
        metadata: { source: 'sdk-contract' },
      });
      expect(session.summary).toMatchObject({
        id: 'session-explicit',
        metadata: { source: 'sdk-contract' },
      });
      await expect(harness.listSessions()).resolves.toEqual([
        expect.objectContaining({
          id: 'session-explicit',
          metadata: { source: 'sdk-contract' },
        }),
      ]);
    } finally {
      await harness.close();
    }
  });
});

function asyncPrototypeMethodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    const value = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    return (
      typeof value === 'function' &&
      Object.prototype.toString.call(value) === '[object AsyncFunction]'
    );
  });
}
