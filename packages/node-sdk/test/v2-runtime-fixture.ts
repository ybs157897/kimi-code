/**
 * Scenario: real-runtime composition test fixture (BASE-003).
 * Responsibility: serve deterministic scripted OpenAI chat-completions over
 * loopback HTTP and bootstrap a real `KimiV2Runtime` (engine + memory Klient)
 * pointed at it, so composition tests exercise the genuine runtime instead of
 * mocking `createKimiV2Runtime()`.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiV2Runtime, type KimiV2Runtime } from '../src/v2';

export type ScriptedProviderResponse =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly kind: 'error'; readonly status: number; readonly message: string };

export interface RecordedProviderRequest {
  readonly body: {
    readonly model?: string;
    readonly stream?: boolean;
    readonly messages?: readonly unknown[];
    readonly tools?: readonly unknown[];
  };
}

export interface FakeProvider {
  readonly baseUrl: string;
  readonly requests: readonly RecordedProviderRequest[];
  /** Queue scripted responses; one is consumed per chat-completions call. */
  push(...responses: readonly ScriptedProviderResponse[]): void;
  close(): Promise<void>;
}

export interface FakeProviderOptions {
  /**
   * Optional response used whenever the explicit script queue is empty.
   * This is useful for public-contract tests that vary a simple text response
   * between prompts without coupling each call site to the HTTP fixture.
   */
  readonly fallbackResponse?: () => ScriptedProviderResponse;
}

const FAKE_WIRE_MODEL = 'stub-model';

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkBase(id: string): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: FAKE_WIRE_MODEL,
  };
}

function usageChunk(id: string): string {
  return sseChunk({
    ...chunkBase(id),
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  });
}

function renderScriptedResponse(
  response: Exclude<ScriptedProviderResponse, { readonly kind: 'error' }>,
  index: number,
): string {
  const id = `chatcmpl-scripted-${String(index)}`;
  const parts: string[] = [];
  if (response.kind === 'text') {
    parts.push(
      sseChunk({
        ...chunkBase(id),
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: response.text },
            finish_reason: null,
          },
        ],
      }),
    );
    parts.push(
      sseChunk({
        ...chunkBase(id),
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
    );
  } else {
    parts.push(
      sseChunk({
        ...chunkBase(id),
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: response.id,
                  type: 'function',
                  function: { name: response.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    parts.push(
      sseChunk({
        ...chunkBase(id),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: response.arguments } }],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    parts.push(
      sseChunk({
        ...chunkBase(id),
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    );
  }
  parts.push(usageChunk(id));
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

/** Start a loopback OpenAI chat-completions endpoint driven by a script queue. */
export async function startFakeProvider(
  options: FakeProviderOptions = {},
): Promise<FakeProvider> {
  const script: ScriptedProviderResponse[] = [];
  const requests: RecordedProviderRequest[] = [];
  let responseIndex = 0;

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url?.endsWith('/chat/completions') !== true) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found' } }));
      return;
    }
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      let body: RecordedProviderRequest['body'] = {};
      try {
        body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) as RecordedProviderRequest['body'];
      } catch {
        // Keep the raw parse failure visible via an empty recorded body.
      }
      requests.push({ body });

      const scripted = script.shift() ?? options.fallbackResponse?.();
      if (scripted === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `fake provider script exhausted at request ${String(requests.length)}`,
              type: 'script_exhausted',
            },
          }),
        );
        return;
      }
      if (scripted.kind === 'error') {
        res.writeHead(scripted.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: scripted.message, type: 'scripted_error' } }));
        return;
      }
      responseIndex += 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(renderScriptedResponse(scripted, responseIndex));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    push: (...responses) => {
      script.push(...responses);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export interface V2RuntimeRigOptions {
  /** Reuse an existing home (cold-resume tests); created and owned otherwise. */
  readonly homeDir?: string;
}

export interface V2RuntimeRig {
  readonly runtime: KimiV2Runtime;
  readonly homeDir: string;
  readonly workDir: string;
  /** Model identifier registered through the Klient kosong facade. */
  readonly modelId: string;
  readonly provider: FakeProvider;
  createSession(input?: { readonly title?: string }): Promise<{ readonly id: string }>;
  close(): Promise<void>;
}

/**
 * Bootstrap a real v2 runtime whose only stubbed boundary is the model
 * endpoint. The engine, session persistence, wire records, and memory Klient
 * all run for real.
 */
export async function createV2RuntimeRig(options: V2RuntimeRigOptions = {}): Promise<V2RuntimeRig> {
  const ownsHomeDir = options.homeDir === undefined;
  const homeDir = options.homeDir ?? (await mkdtemp(join(tmpdir(), 'kimi-v2-rig-home-')));
  const workDir = await mkdtemp(join(tmpdir(), 'kimi-v2-rig-workdir-'));
  const provider = await startFakeProvider();
  const modelId = 'fake-loopback-model';

  const cleanupDirs = async (): Promise<void> => {
    const targets = ownsHomeDir ? [homeDir, workDir] : [workDir];
    await Promise.all(
      targets.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })),
    );
  };

  let runtime: KimiV2Runtime;
  try {
    runtime = await createKimiV2Runtime({ homeDir, clientVersion: 'test' });
  } catch (error) {
    await provider.close();
    await cleanupDirs();
    throw error;
  }

  try {
    await runtime.klient.global.kosong.addProvider({
      id: modelId,
      model: FAKE_WIRE_MODEL,
      protocol: 'openai',
      baseUrl: provider.baseUrl,
      auth: { method: 'api-key', apiKey: 'YOUR_API_KEY' },
      maxContextSize: 128_000,
      capabilities: { tool_use: true },
    });
  } catch (error) {
    await runtime.close();
    await provider.close();
    await cleanupDirs();
    throw error;
  }

  let closed = false;
  return {
    runtime,
    homeDir,
    workDir,
    modelId,
    provider,
    createSession: async (input = {}) => {
      const session = await runtime.klient.global.sessions.create({
        workDir,
        title: input.title ?? 'rig session',
        mainAgentBinding: { profile: 'agent', model: modelId },
      });
      return { id: session.id };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await runtime.close();
      } finally {
        try {
          await provider.close();
        } finally {
          await cleanupDirs();
        }
      }
    },
  };
}
