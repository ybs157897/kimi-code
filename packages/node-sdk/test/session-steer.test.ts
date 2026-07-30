import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';
import { startFakeProvider, type FakeProvider } from './v2-runtime-fixture';

const tempDirs: string[] = [];
let fakeProvider: FakeProvider | undefined;

beforeEach(async () => {
  fakeProvider = await startFakeProvider();
});

afterEach(async () => {
  await fakeProvider?.close();
  fakeProvider = undefined;
  await removeTempDirs(tempDirs);
});

describe('Session.steer', () => {
  it('sends turn.steer to the core session runtime', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_steer_wire', workDir });
      let resolveApproval!: () => void;
      const approvalResolution = new Promise<void>((resolve) => {
        resolveApproval = resolve;
      });
      let markHandlerStarted!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        markHandlerStarted = resolve;
      });
      session.setApprovalHandler(async () => {
        markHandlerStarted();
        await approvalResolution;
        return { decision: 'approved' };
      });
      requireFakeProvider().push(
        {
          kind: 'tool_call',
          id: 'call_steer_hold',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'printf steer-ready' }),
        },
        { kind: 'text', text: 'steer response' },
      );
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended', 5_000);
      const steered = waitForSDKEvent(
        session,
        (event) => event.type === 'prompt.steered',
        5_000,
      );

      await session.prompt('start the active turn');
      await handlerStarted;
      try {
        await session.steer('also do this');
      } finally {
        resolveApproval();
      }
      await ended;

      await expect(steered).resolves.toMatchObject({
        type: 'prompt.steered',
        sessionId: session.id,
        agentId: 'main',
        content: [{ type: 'text', text: 'also do this' }],
      });
      expect(providerMessages(1)).toContain('also do this');
    } finally {
      await harness.close();
    }
  });

  it('rejects empty steer input', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_empty', workDir });

      await expect(session.steer('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.prompt_input_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-steer-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_steer_closed', workDir });
      await session.close();

      await expect(session.steer('hello')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});

async function configureFakeProvider(
  harness: ReturnType<typeof createKimiHarness>,
): Promise<void> {
  await harness.setConfig({
    models: {
      'fake-model': {
        name: 'stub-model',
        protocol: 'openai',
        baseUrl: requireFakeProvider().baseUrl,
        apiKey: 'YOUR_API_KEY',
        maxContextSize: 262144,
        capabilities: ['tool_use'],
      },
    },
    defaultModel: 'fake-model',
  });
}

function requireFakeProvider(): FakeProvider {
  if (fakeProvider === undefined) throw new Error('Fake provider was not initialized');
  return fakeProvider;
}

function providerMessages(index: number): string {
  return JSON.stringify(requireFakeProvider().requests[index]?.body.messages ?? []);
}
