/**
 * Scenario: v2 print background policy and Runtime + Klient rendering.
 * Responsibilities: preserve print completion behavior and render the public
 * Klient event contract in text/stream-json modes. Runtime creation is the
 * only stubbed host boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/cli/run-v2-print.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import type { CLIOptions } from '#/cli/options';
import {
  applyPrintBackgroundPolicy,
  createPrintTurnEndings,
  PrintSteeredTurnFailedError,
  runV2Print,
  type PrintTurnEnding,
  type PrintTurnEndings,
} from '#/cli/v2/run-v2-print';

const hostMocks = vi.hoisted(() => ({
  createKimiV2Runtime: vi.fn(),
  createKimiDefaultHeaders: vi.fn(() => ({ 'User-Agent': 'kimi-test' })),
  createKimiDeviceId: vi.fn(
    (_homeDir: string, options?: { readonly onFirstLaunch?: () => void }) => {
      options?.onFirstLaunch?.();
      return 'device-test';
    },
  ),
  getCachedAccessToken: vi.fn(async () => 'access-test'),
}));

vi.mock('@moonshot-ai/kimi-code-sdk/v2', () => ({
  createKimiV2Runtime: hostMocks.createKimiV2Runtime,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    KimiAuthFacade: class {
      getCachedAccessToken = hostMocks.getCachedAccessToken;
    },
    resolveConfigPath: () => '/tmp/kimi-v2-host-test/config.toml',
    resolveKimiHome: () => '/tmp/kimi-v2-host-test',
  };
});

vi.mock('@moonshot-ai/kimi-code-oauth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@moonshot-ai/kimi-code-oauth')>();
  return {
    ...actual,
    createKimiDefaultHeaders: hostMocks.createKimiDefaultHeaders,
    createKimiDeviceId: hostMocks.createKimiDeviceId,
  };
});

function ending(
  turnId: number,
  reason: PrintTurnEnding['reason'] = 'completed',
): PrintTurnEnding {
  return { type: 'turn.ended', turnId, reason };
}

interface ScriptedEntry {
  readonly event: PrintTurnEnding;
  /** Side effect applied when this entry is consumed (e.g. mutate pending). */
  readonly apply?: () => void;
}

/**
 * Scripted `PrintTurnEndings`: replays queued endings (honouring `skipTurnId`),
 * then resolves `null` once the script is exhausted (the wait "timed out").
 */
function scriptedTurnEndings(entries: ScriptedEntry[]): PrintTurnEndings {
  const queue = [...entries];
  return {
    next: async (_remainingMs: number, skipTurnId: number) => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.event.turnId === skipTurnId) continue;
        entry.apply?.();
        return entry.event;
      }
      return null;
    },
  };
}

describe('applyPrintBackgroundPolicy', () => {
  it('exit returns immediately without draining or waiting', async () => {
    const drain = vi.fn(async () => {});
    const countPending = vi.fn(() => 1);
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 60,
      maxTurns: 50,
      countPending,
      drain,
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
    });
    expect(drain).not.toHaveBeenCalled();
    expect(countPending).not.toHaveBeenCalled();
  });

  it('drain drains once and returns', async () => {
    const drain = vi.fn(async () => {});
    await applyPrintBackgroundPolicy({
      mode: 'drain',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 1,
      drain,
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
    });
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('steer returns once background tasks are quiescent', async () => {
    let pending = 1;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => pending,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        // The main turn's own buffered ending is skipped.
        { event: ending(1) },
        // A background task completed and steered a new turn; it finished and
        // no tasks remain.
        { event: ending(2), apply: () => { pending = 0; } },
      ]),
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('steer finishes with a warning when max turns is reached', async () => {
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 60,
      maxTurns: 2,
      countPending: () => 1,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([{ event: ending(2) }, { event: ending(3) }]),
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('max turns');
  });

  it('steer finishes with a warning when the ceiling is reached', async () => {
    let now = 0;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 10,
      maxTurns: 50,
      countPending: () => 1,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { now = 10_001; } },
      ]),
      skipTurnId: 1,
      warn,
      now: () => now,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('ceiling');
  });

  it('steer returns when the wait times out with tasks still pending', async () => {
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 1,
      drain: async () => {},
      // Empty script: no further turn ends before the deadline.
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('steer throws when a steered turn does not complete', async () => {
    await expect(
      applyPrintBackgroundPolicy({
        mode: 'steer',
        ceilingS: 60,
        maxTurns: 50,
        countPending: () => 1,
        drain: async () => {},
        turnEndings: scriptedTurnEndings([
          {
            event: {
              type: 'turn.ended',
              turnId: 2,
              reason: 'failed',
              error: { code: 'provider.overloaded', message: 'try later' },
            } as PrintTurnEnding,
          },
        ]),
        skipTurnId: 1,
        warn: () => {},
        now: () => Date.now(),
      }),
    ).rejects.toThrow(PrintSteeredTurnFailedError);
  });

  it('waits for goal continuation turns before applying the mode', async () => {
    let active = true;
    let consumed = 0;
    const drain = vi.fn(async () => {});
    await applyPrintBackgroundPolicy({
      mode: 'drain',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 0,
      drain,
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { consumed += 1; } },
        {
          event: ending(3),
          apply: () => {
            consumed += 1;
            active = false;
          },
        },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
      goalActive: () => active,
    });
    // Both continuation turns ended before the mode ('drain') ran.
    expect(consumed).toBe(2);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('warns and returns when the goal wait hits the ceiling', async () => {
    let now = 0;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 10,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      // No continuation turn ever ends; the poll interval elapses each time.
      turnEndings: {
        next: async () => {
          now = 10_001;
          return null;
        },
      },
      skipTurnId: 1,
      warn,
      now: () => now,
      goalActive: () => true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('goal wait ceiling');
  });

  it('exits the goal wait promptly when the goal settles without a turn ending', async () => {
    let active = true;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      // Poll interval elapses; the goal settles (paused/blocked) mid-wait
      // without producing a turn.ended.
      turnEndings: {
        next: async () => {
          active = false;
          return null;
        },
      },
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
      goalActive: () => active,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an exit-mode run alive until a pending cron fire steered a turn', async () => {
    let nextFire: number | null = 60_000;
    let fireTurnEnded = false;
    const cronNextFireAt = vi.fn(() => nextFire);
    const countPending = vi.fn(() => 0);
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        {
          // The cron fire steered this turn; once it ends the one-shot task
          // is gone.
          event: ending(2),
          apply: () => {
            fireTurnEnded = true;
            nextFire = null;
          },
        },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => 0,
      cronNextFireAt,
    });
    // The policy waited for the fire turn's ending instead of returning
    // immediately, then re-read the (now empty) cron schedule.
    expect(fireTurnEnded).toBe(true);
    expect(cronNextFireAt).toHaveBeenCalledTimes(2);
    // 'exit' never consults background tasks.
    expect(countPending).not.toHaveBeenCalled();
  });

  it('throws when a cron-fire steered turn does not complete', async () => {
    await expect(
      applyPrintBackgroundPolicy({
        mode: 'exit',
        ceilingS: 3600,
        maxTurns: 50,
        countPending: () => 0,
        drain: async () => {},
        turnEndings: scriptedTurnEndings([
          {
            event: {
              type: 'turn.ended',
              turnId: 2,
              reason: 'failed',
              error: { code: 'provider.overloaded', message: 'try later' },
            } as PrintTurnEnding,
          },
        ]),
        skipTurnId: 1,
        warn: () => {},
        now: () => 0,
        cronNextFireAt: () => 60_000,
      }),
    ).rejects.toThrow(PrintSteeredTurnFailedError);
  });

  it('keeps waiting while a recurring cron advances its next fire time', async () => {
    let nextFire: number | null = 10_000;
    const cronNextFireAt = vi.fn(() => nextFire);
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        // First fire: the recurring task advances to its next slot.
        { event: ending(2), apply: () => { nextFire = 20_000; } },
        // Second fire: the task is deleted, no future fire remains.
        { event: ending(3), apply: () => { nextFire = null; } },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => 0,
      cronNextFireAt,
    });
    expect(cronNextFireAt).toHaveBeenCalledTimes(3);
  });

  it('re-reads the cron schedule when the fire wait times out without a turn', async () => {
    let nextFire: number | null = 10_000;
    const cronNextFireAt = vi.fn(() => {
      const value = nextFire;
      // The task was removed between the first query and the re-check.
      nextFire = null;
      return value;
    });
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      // Empty script: the fire produced no turn before the grace elapsed.
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn,
      now: () => 0,
      cronNextFireAt,
    });
    expect(cronNextFireAt).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and stops cron waiting when the next fire time is stuck in the past', async () => {
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      // No turn ever ends: the tick is wedged and never fires the overdue task.
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn,
      now: () => 1_000,
      cronNextFireAt: () => 500,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('cron');
  });

  it('finishes goal waiting before consulting the cron schedule', async () => {
    let active = true;
    let consumed = 0;
    let nextFire: number | null = 60_000;
    let cronFirstCallAtConsumed = -1;
    const cronNextFireAt = vi.fn(() => {
      if (cronFirstCallAtConsumed === -1) cronFirstCallAtConsumed = consumed;
      return nextFire;
    });
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { consumed += 1; } },
        {
          event: ending(3),
          apply: () => {
            consumed += 1;
            active = false;
          },
        },
        // The pending cron fire steered this turn.
        { event: ending(4), apply: () => { nextFire = null; } },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => 0,
      goalActive: () => active,
      cronNextFireAt,
    });
    // Both goal continuation turns ended before the cron schedule was read.
    expect(cronFirstCallAtConsumed).toBe(2);
    expect(cronNextFireAt).toHaveBeenCalled();
  });
});

describe('createPrintTurnEndings', () => {
  it('buffers events pushed before next() and skips the given turn id', async () => {
    const endings = createPrintTurnEndings();
    endings.push(ending(1));
    endings.push(ending(2));
    await expect(endings.next(1000, 1)).resolves.toMatchObject({ turnId: 2 });
  });

  it('delivers a pushed event to a pending next()', async () => {
    const endings = createPrintTurnEndings();
    const pending = endings.next(1000, 1);
    endings.push(ending(3));
    await expect(pending).resolves.toMatchObject({ turnId: 3 });
  });

  it('resolves null when the remaining time elapses', async () => {
    const endings = createPrintTurnEndings();
    await expect(endings.next(5, 1)).resolves.toBeNull();
  });

  it('keeps waiting when only the skipped turn ends', async () => {
    const endings = createPrintTurnEndings();
    const pending = endings.next(1000, 1);
    endings.push(ending(1));
    endings.push(ending(4));
    await expect(pending).resolves.toMatchObject({ turnId: 4 });
  });
});

describe('runV2Print (Runtime + Klient host contract)', () => {
  it('runs a text prompt when listeners attach asynchronously, preserving the response', async () => {
    const rig = createPrintHostRig([
      { type: 'assistant.delta', turnId: 1, delta: 'hello from klient' },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
    ]);
    const stdout = testWriter();
    const stderr = testWriter();

    await runV2Print(
      printOptions({ skillsDirs: ['/skills'] }),
      '1.2.3-test',
      { stdout, stderr },
    );

    expect(hostMocks.createKimiV2Runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        homeDir: '/tmp/kimi-v2-host-test',
        clientVersion: '1.2.3-test',
        skillDirs: ['/skills'],
        mode: 'print',
      }),
    );
    expect(rig.runtime.klient.global.sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: {
        profile: 'agent',
        model: 'k2',
      },
    });
    expect(rig.agent.setModel).not.toHaveBeenCalled();
    expect(rig.agent.setPermission).toHaveBeenCalledWith('auto');
    expect(rig.agent.prompt).toHaveBeenCalledWith({
      input: [{ type: 'text', text: 'hello' }],
    });
    expect(stdout.text()).toContain('hello from klient');
    expect(stderr.text()).toContain('kimi version 1.2.3-test');
    expect(rig.runtime.close).toHaveBeenCalledTimes(1);
  });

  it('owns Cloud Telemetry context and shutdown through the Runtime facade', async () => {
    const rig = createPrintHostRig([
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
    ]);

    await runV2Print(printOptions({ model: 'k2-selected' }), '1.2.3-test', {
      stdout: testWriter(),
      stderr: testWriter(),
    });

    const runtimeOptions = hostMocks.createKimiV2Runtime.mock.calls.at(-1)?.[0];
    expect(runtimeOptions).toMatchObject({
      telemetry: {
        enabled: true,
        deviceId: 'device-test',
        appName: 'kimi-code-cli',
        uiMode: 'print',
        model: 'k2-selected',
      },
    });
    await expect(runtimeOptions.telemetry.getAccessToken()).resolves.toBe('access-test');
    expect(rig.runtime.telemetry.setContext).toHaveBeenCalledWith({
      sessionId: 'ses_klient',
      model: 'k2-selected',
    });
    expect(rig.runtime.telemetry.track).toHaveBeenCalledWith('first_launch');
    expect(rig.runtime.telemetry.track).toHaveBeenCalledWith('exit', {
      duration_ms: expect.any(Number),
    });
    expect(rig.runtime.close).toHaveBeenCalledTimes(1);
  });

  it('seeds an agent file and binds its resolved profile through Klient', async () => {
    const rig = createPrintHostRig(
      [{ type: 'turn.ended', turnId: 1, reason: 'completed' }],
      { agentFileProfileName: 'file-reviewer' },
    );

    await runV2Print(
      printOptions({ agentFiles: ['./reviewer.md'] }),
      '1.2.3-test',
      { stdout: testWriter(), stderr: testWriter() },
    );

    expect(hostMocks.createKimiV2Runtime).toHaveBeenCalledWith(
      expect.objectContaining({ agentFiles: ['./reviewer.md'] }),
    );
    expect(rig.runtime.agentFiles.resolveProfileName).toHaveBeenCalledWith({
      file: './reviewer.md',
      workDir: process.cwd(),
    });
    expect(rig.runtime.klient.global.sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: {
        profile: 'file-reviewer',
        model: 'k2',
      },
    });
    expect(rig.agent.profile.bind).not.toHaveBeenCalled();
  });

  it('creates a headless goal, waits for its terminal snapshot, and writes the summary', async () => {
    const completedGoal = goalSnapshot({ status: 'complete', turnsUsed: 2 });
    const rig = createPrintHostRig(
      [
        { type: 'assistant.delta', turnId: 1, delta: 'goal done' },
        { type: 'turn.ended', turnId: 1, reason: 'completed' },
      ],
      { goalAfterPrompt: completedGoal },
    );
    const stdout = testWriter();

    await runV2Print(
      printOptions({
        prompt: '/goal replace Ship the v2 host',
        outputFormat: 'stream-json',
      }),
      '1.2.3-test',
      { stdout, stderr: testWriter() },
    );

    expect(rig.agent.goal.create).toHaveBeenCalledWith({
      objective: 'Ship the v2 host',
      replace: true,
    });
    expect(rig.agent.prompt).toHaveBeenCalledWith({
      input: [{ type: 'text', text: 'Ship the v2 host' }],
    });
    expect(stdout.jsonLines()).toContainEqual(
      expect.objectContaining({
        type: 'goal.summary',
        status: 'complete',
        turnsUsed: 2,
      }),
    );
  });

  it('keeps the Klient host alive for a scheduled cron turn before exiting', async () => {
    const rig = createPrintHostRig(
      [
        { type: 'turn.ended', turnId: 1, reason: 'completed' },
        { type: 'turn.ended', turnId: 2, reason: 'completed' },
      ],
      { cronNextFireTimes: [Date.now() - 1, null] },
    );

    await runV2Print(printOptions(), '1.2.3-test', {
      stdout: testWriter(),
      stderr: testWriter(),
    });

    expect(rig.session.cron.getNextFireTime).toHaveBeenCalledTimes(2);
  });

  it('renders the required Klient events when stream-json is selected', async () => {
    createPrintHostRig([
      { type: 'turn.step.started', turnId: 1, step: 1 },
      { type: 'assistant.delta', turnId: 1, delta: 'discarded' },
      {
        type: 'turn.step.retrying',
        turnId: 1,
        step: 1,
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 250,
        errorName: 'OverloadedError',
        errorMessage: 'try later',
        statusCode: 503,
      },
      { type: 'assistant.delta', turnId: 1, delta: 'kept' },
      {
        type: 'tool.call.delta',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Read',
        argumentsPart: '{"path":"a.ts"}',
      },
      {
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 'call_1',
        update: { kind: 'progress', text: 'reading' },
      },
      {
        type: 'tool.result',
        turnId: 1,
        toolCallId: 'call_1',
        output: 'file text',
      },
      {
        type: 'hook.result',
        turnId: 1,
        hookEvent: 'PostToolUse',
        content: 'hook output',
      },
      { type: 'turn.step.interrupted', turnId: 1, step: 2, reason: 'stop' },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
    ]);
    const stdout = testWriter();
    const stderr = testWriter();

    await runV2Print(printOptions({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
    });

    expect(stdout.jsonLines()).toEqual([
      { role: 'meta', type: 'system.version', version: '1.2.3-test' },
      {
        role: 'meta',
        type: 'turn.step.retrying',
        failed_attempt: 1,
        next_attempt: 2,
        max_attempts: 3,
        delay_ms: 250,
        error_name: 'OverloadedError',
        error_message: 'try later',
        status_code: 503,
      },
      {
        role: 'assistant',
        content: 'kept',
        tool_calls: [
          {
            type: 'function',
            id: 'call_1',
            function: { name: 'Read', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
      { role: 'assistant', content: 'PostToolUse hook\n\nhook output' },
      {
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'ses_klient',
        command: 'kimi -r ses_klient',
        content: 'To resume this session: kimi -r ses_klient',
      },
    ]);
    expect(stderr.text()).toBe('reading\n');
  });
});

interface TestAgentEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface PrintHostRigOptions {
  readonly agentFileProfileName?: string;
  readonly goalAfterPrompt?: ReturnType<typeof goalSnapshot>;
  readonly cronNextFireTimes?: readonly (number | null)[];
}

function createPrintHostRig(
  promptEvents: readonly TestAgentEvent[],
  options: PrintHostRigOptions = {},
) {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const pendingListeners: Array<{
    readonly name: string;
    readonly listener: (event: never) => void;
  }> = [];
  const emit = (event: TestAgentEvent): void => {
    for (const listener of listeners.get(event.type) ?? []) {
      listener(event as never);
    }
  };
  const profileState = {
    cwd: process.cwd(),
    modelAlias: undefined as string | undefined,
    modelCapabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 1,
    },
    profileName: undefined as string | undefined,
    thinkingLevel: 'off',
    systemPrompt: '',
  };
  let goal: ReturnType<typeof goalSnapshot> | null = null;
  const agent = {
    events: {
      on: vi.fn((name: string, listener: (event: never) => void) => {
        pendingListeners.push({ name, listener });
        return {
          dispose: () => {
            listeners.get(name)?.delete(listener);
          },
        };
      }),
    },
    getModel: vi.fn(async () => {
      for (const pending of pendingListeners.splice(0)) {
        const entries = listeners.get(pending.name) ?? new Set();
        entries.add(pending.listener);
        listeners.set(pending.name, entries);
      }
      return '';
    }),
    setModel: vi.fn(async (model: string) => {
      profileState.modelAlias = model;
      profileState.profileName ??= 'agent';
      return { model };
    }),
    setPermission: vi.fn(async () => {}),
    getTasks: vi.fn(async () => []),
    prompt: vi.fn(async () => {
      for (const event of promptEvents) emit(event);
      if (options.goalAfterPrompt !== undefined) goal = options.goalAfterPrompt;
      return { turn_id: 1 };
    }),
    profile: {
      get: vi.fn(async () => ({ ...profileState })),
      bind: vi.fn(async (input: { readonly profile: string; readonly model?: string }) => {
        profileState.profileName = input.profile;
        profileState.modelAlias = input.model;
      }),
    },
    goal: {
      get: vi.fn(async () => goal),
      create: vi.fn(
        async (input: { readonly objective: string; readonly replace?: boolean }) => {
          goal = goalSnapshot({ objective: input.objective, status: 'active' });
          return goal;
        },
      ),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    },
  };
  const cronNextFireTimes = [...(options.cronNextFireTimes ?? [])];
  const session = {
    agent: vi.fn(() => agent),
    agents: vi.fn(async () => ({ main: { id: 'main' } })),
    restore: vi.fn(async () => true),
    status: vi.fn(async () => 'idle'),
    cron: {
      list: vi.fn(async () => []),
      getNextFireTime: vi.fn(async () => cronNextFireTimes.shift() ?? null),
    },
  };
  const runtime = {
    klient: {
      global: {
        config: {
          diagnostics: vi.fn(async () => []),
          get: vi.fn(async (domain: string) => {
            if (domain === 'defaultModel') return 'k2';
            return {};
          }),
        },
        sessions: {
          create: vi.fn(async () => ({ id: 'ses_klient' })),
          get: vi.fn(),
          list: vi.fn(),
        },
        auth: { ensureReady: vi.fn(async () => {}) },
      },
      session: vi.fn(() => session),
    },
    telemetry: {
      setContext: vi.fn(),
      track: vi.fn(),
      shutdown: vi.fn(async () => {}),
    },
    agentFiles: {
      resolveProfileName: vi.fn(
        async () => options.agentFileProfileName ?? 'file-agent',
      ),
    },
    close: vi.fn(async () => {}),
  };
  hostMocks.createKimiV2Runtime.mockResolvedValue(runtime);
  return { agent, runtime, session };
}

function goalSnapshot(
  overrides: Partial<{
    goalId: string;
    objective: string;
    status: 'active' | 'paused' | 'blocked' | 'complete';
    turnsUsed: number;
    tokensUsed: number;
    wallClockMs: number;
  }> = {},
) {
  return {
    goalId: 'goal-test',
    objective: 'test objective',
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
    ...overrides,
  };
}

function printOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  };
}

function testWriter() {
  let value = '';
  return {
    write: vi.fn((chunk: string) => {
      value += chunk;
      return true;
    }),
    text: () => value,
    jsonLines: () =>
      value
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
}
