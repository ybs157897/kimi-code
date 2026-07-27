/**
 * Scenario: the v2 SDK Runtime owns engine and host telemetry resources.
 * Responsibility: expose only Klient plus narrow host lifecycle facades, and
 * flush those resources when the Runtime closes.
 * Run: pnpm --filter @moonshot-ai/kimi-code-sdk exec vitest run test/v2-runtime.test.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
