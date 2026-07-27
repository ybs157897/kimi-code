/**
 * Stable `/api/v1` code-extension control-plane scenarios.
 *
 * Boots a real server with an isolated extension, exercises command discovery,
 * reload, and main-Agent activation, and verifies route validation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id: string;
}

const CONFIG = [
  'default_model = "stub"',
  '',
  '[providers.stub]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:9999"',
  'api_key = "stub"',
  '',
  '[models.stub]',
  'provider = "stub"',
  'model = "stub"',
  'max_context_size = 1000',
  '',
].join('\n');

describe('/api/v1 extensions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kap-server-extensions-'));
    await writeFile(join(home, 'config.toml'), CONFIG, 'utf8');
    await mkdir(join(home, 'extensions'), { recursive: true });
    await writeFile(
      join(home, 'extensions', 'example.ts'),
      [
        'export default (api) => {',
        "  api.registerCommand('hello', { description: 'Say hello', prompt: (args) => `hello ${args}` });",
        '};',
      ].join('\n'),
      'utf8',
    );
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      });
      home = undefined;
    }
  });

  it('lists extension commands as serializable definitions', async () => {
    const sessionId = await createSession();
    const listed = await getJson<{
      commands: Array<{ extension_id: string; name: string; description: string }>;
    }>(`/api/v1/sessions/${sessionId}/extensions/commands`);
    expect(listed.body).toMatchObject({
      code: 0,
      data: {
        commands: [
          {
            extension_id: 'example',
            name: 'hello',
            description: 'Say hello',
          },
        ],
      },
    });
  });

  it('returns the active extension snapshot after reload', async () => {
    const sessionId = await createSession();
    const reloaded = await postJson<{ active: string[]; errors: unknown[] }>(
      `/api/v1/sessions/${sessionId}/extensions/reload`,
      {},
    );
    expect(reloaded.body.code).toBe(0);
    expect(reloaded.body.data.active).toEqual([join(home!, 'extensions', 'example.ts')]);
    expect(reloaded.body.data.errors).toEqual([]);
  });

  it('returns false when the addressed extension command does not exist', async () => {
    const sessionId = await createSession();
    const activated = await postJson<{ activated: boolean }>(
      `/api/v1/sessions/${sessionId}/extensions/commands/activate`,
      { extension_id: 'missing', name: 'missing' },
    );
    expect(activated.body).toMatchObject({
      code: 0,
      data: { activated: false },
    });
  });

  it('rejects malformed activation input at the route boundary', async () => {
    const response = await postJson<null>(
      '/api/v1/sessions/missing/extensions/commands/activate',
      { extension_id: '', name: '' },
    );

    expect(response.body.code).toBe(40001);
  });

  it('returns the stable session-not-found envelope for a missing session', async () => {
    const response = await getJson<null>(
      '/api/v1/sessions/missing/extensions/commands',
    );

    expect(response.body).toMatchObject({
      code: 40401,
      data: null,
    });
  });

  async function getJson<T>(path: string): Promise<{ body: Envelope<T> }> {
    const response = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { body: (await response.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const created = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home },
    });
    return created.body.data.id;
  }

  async function postJson<T>(
    path: string,
    body: unknown,
  ): Promise<{ body: Envelope<T> }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        ...authHeaders(server as RunningServer),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return { body: (await response.json()) as Envelope<T> };
  }
});
