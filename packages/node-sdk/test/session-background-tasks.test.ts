/**
 * Scenario: root SDK background-task and print completion controls use v2 task state.
 * Responsibilities: list/output validation plus no-task print completion.
 * Wiring: real SDK/Core runtime with no external provider.
 * Run: pnpm exec vitest run test/session-background-tasks.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.listBackgroundTasks / getBackgroundTaskOutput', () => {
  it('rejects the legacy pre-turn drain option instead of silently ignoring it', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-background-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-background-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(
        harness.createSession({
          id: 'ses_background_legacy_drain',
          workDir,
          drainAgentTasksOnStop: true,
        }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'not_implemented',
        details: { option: 'drainAgentTasksOnStop' },
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('finishes print background policy immediately when no tasks are active', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-background-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-background-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_background_print', workDir });
      await expect(session.waitForBackgroundTasksOnPrint()).resolves.toBeUndefined();
      await expect(session.handlePrintMainTurnCompleted()).resolves.toBe('finish');
    } finally {
      await harness.close();
    }
  });

  it('lists an empty task set for a fresh session', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_list_empty', workDir });
      const tasks = await session.listBackgroundTasks();
      expect(tasks).toEqual([]);

      const filtered = await session.listBackgroundTasks({ activeOnly: true });
      expect(filtered).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('returns empty output for an unknown task id', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_unknown', workDir });
      // Unknown task ids must not throw — UI fetches output speculatively.
      await expect(session.getBackgroundTaskOutput('bash-deadbeef')).resolves.toBe('');
    } finally {
      await harness.close();
    }
  });

  it('rejects empty task ids with a stable error code', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_empty_id', workDir });
      await expect(session.getBackgroundTaskOutput('')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'task.task_id_empty',
      } satisfies Partial<KimiError>);
      await expect(session.stopBackgroundTask('')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'task.task_id_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_closed', workDir });
      await session.close();

      await expect(session.listBackgroundTasks()).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
      await expect(session.getBackgroundTaskOutput('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
      await expect(session.stopBackgroundTask('bash-aaaaaaaa')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('stopBackgroundTask is a no-op for an unknown task id', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-bgtask-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_bg_stop_unknown', workDir });
      // Unknown task ids must not throw — the core BPM silently no-ops.
      await expect(
        session.stopBackgroundTask('bash-deadbeef', { reason: 'test' }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
