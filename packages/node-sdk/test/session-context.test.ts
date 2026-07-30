/**
 * Scenario: root SDK context and additional-directory commands use v2 guarded commands.
 * Responsibilities: persisted directory mutation, explicit temporary exception, clear/import.
 * Wiring: real SDK/Core runtime without an external provider.
 * Run: pnpm exec vitest run test/session-context.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session context', () => {
  it('rejects temporary additional directories because v2 cannot restore persist:false', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-work-');
    const additionalDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-dir-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_additional_resume', workDir });
      await expect(
        session.addAdditionalDir(additionalDir, { persist: false }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'not_implemented',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('persists an additional directory through close and resume', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-work-');
    const additionalDir = await makeTempDir(tempDirs, 'kimi-sdk-additional-dir-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_additional_persist', workDir });
      await expect(session.addAdditionalDir(additionalDir)).resolves.toMatchObject({
        additionalDirs: [additionalDir],
        persisted: true,
      });
      await expect(session.reloadSession()).resolves.toMatchObject({
        id: session.id,
        additionalDirs: [additionalDir],
      });
    } finally {
      await harness.close();
    }
  });

  it('clears an agent context without replacing the session', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_clear', workDir });
      await expect(session.getContext()).resolves.toEqual({ history: [], tokenCount: 0 });

      await session.clearContext();

      expect(session.id).toBe('ses_context_clear');
      await expect(session.getContext()).resolves.toEqual({ history: [], tokenCount: 0 });
    } finally {
      await harness.close();
    }
  });

  it('imports context through the guarded v2 context command', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-context-import-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-context-import-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_context_import', workDir });

      await expect(
        session.importContext('Earlier user: keep the API stable.', "file 'notes.md'"),
      ).resolves.toBeUndefined();
      await expect(session.getContext()).resolves.toMatchObject({
        history: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Earlier user: keep the API stable.' }],
            origin: { kind: 'injection', variant: 'context_import' },
            note: "file 'notes.md'",
          },
        ],
      });
    } finally {
      await harness.close();
    }
  });
});
