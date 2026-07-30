import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CLIOptions } from '#/cli/options';
import { runShell } from '#/cli/run-shell';

import { captureProcessWrite, ExitCalled, mockProcessExit } from '../helpers/process';

const mocks = vi.hoisted(() => {
  class TuiConfigParseError extends Error {
    constructor(
      readonly fallback: {
        readonly theme: 'dark' | 'light' | 'auto';
        readonly editorCommand: string | null;
        readonly notifications: {
          readonly enabled: boolean;
          readonly condition: 'unfocused' | 'always';
        };
      },
    ) {
      super('Invalid TUI config; using defaults.');
    }
  }

  return {
    runV2Shell: vi.fn(async () => {}),
    loadTuiConfig: vi.fn(),
    getColorPalette: vi.fn(async () => ({})),
    setPalette: vi.fn(),
    detectPendingMigration: vi.fn<() => Promise<unknown>>(async () => null),
    createCliV2Runtime: vi.fn(),
    createKlientTUIRuntime: vi.fn(),
    runtimeClose: vi.fn(async () => {}),
    telemetryTrack: vi.fn(),
    getConfigDiagnostics: vi.fn(async () => [] as readonly string[]),
    tuiConstructor: vi.fn(),
    tuiStart: vi.fn(async () => {}),
    tuiGetStartupMcpMs: vi.fn(async () => 0),
    tuiGetCurrentSessionId: vi.fn(() => ''),
    tuiHasSessionContent: vi.fn(() => false),
    flushDiagnosticLogsSync: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    execSync: vi.fn(),
    spawnSync: vi.fn(),
    restoreTerminalModes: vi.fn(),
    TuiConfigParseError,
  };
});

vi.mock('../../src/cli/v2/run-v2-shell', () => ({
  runV2Shell: mocks.runV2Shell,
}));

vi.mock('../../src/cli/v2/create-v2-runtime', () => ({
  createCliV2Runtime: mocks.createCliV2Runtime,
}));

vi.mock('../../src/tui/runtime/tui-runtime', () => ({
  createKlientTUIRuntime: mocks.createKlientTUIRuntime,
}));

vi.mock('../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: mocks.TuiConfigParseError,
}));

vi.mock('../../src/tui/theme', () => ({
  currentTheme: { setPalette: mocks.setPalette },
  getColorPalette: mocks.getColorPalette,
}));

vi.mock('../../src/migration/index', () => ({
  detectPendingMigration: mocks.detectPendingMigration,
}));

vi.mock('../../src/tui/index', () => ({
  KimiTUI: class {
    onExit?: (exitCode?: number) => Promise<void>;
    exitOpenUrl: string | undefined;
    exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

    constructor(...args: unknown[]) {
      mocks.tuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
    getStartupMcpMs = mocks.tuiGetStartupMcpMs;
    getCurrentSessionId = mocks.tuiGetCurrentSessionId;
    hasSessionContent = mocks.tuiHasSessionContent;
  },
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    flushDiagnosticLogsSync: mocks.flushDiagnosticLogsSync,
    log: { info: mocks.logInfo, error: mocks.logError },
  };
});

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
  spawnSync: mocks.spawnSync,
}));

vi.mock('../../src/utils/terminal-restore', () => ({
  restoreTerminalModes: mocks.restoreTerminalModes,
}));

function shellOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: undefined,
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    ...overrides,
  };
}

function arrangeV2Runtime(): void {
  mocks.loadTuiConfig.mockResolvedValue({
    theme: 'dark',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
  });
  const runtime = {
    telemetry: { track: mocks.telemetryTrack },
    close: mocks.runtimeClose,
  };
  mocks.createCliV2Runtime.mockResolvedValue({
    runtime,
    homeDir: '/tmp/kimi-v2-home',
    firstLaunch: false,
  });
  mocks.createKlientTUIRuntime.mockResolvedValue({
    environment: {
      homeDir: '/tmp/kimi-v2-home',
      getExperimentalFeatures: vi.fn(async () => []),
      getConfigDiagnostics: mocks.getConfigDiagnostics,
      close: mocks.runtimeClose,
    },
  });
}

describe('runShell', () => {
  let processOn: ReturnType<typeof vi.spyOn>;
  let processOff: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
    processOff = vi.spyOn(process, 'off').mockImplementation(() => process);
    arrangeV2Runtime();
  });

  afterEach(() => {
    processOn.mockRestore();
    processOff.mockRestore();
    vi.clearAllMocks();
  });

  it('uses the v2 shell entry for normal and migrate-only commands', async () => {
    const options = shellOptions();

    await runShell(options, '1.2.3-test');
    await runShell(options, '1.2.3-test', { migrateOnly: true });

    expect(mocks.runV2Shell).toHaveBeenNthCalledWith(1, options, '1.2.3-test', {});
    expect(mocks.runV2Shell).toHaveBeenNthCalledWith(
      2,
      options,
      '1.2.3-test',
      { migrateOnly: true },
    );
  });

  it(
    'composes the TUI with a lifecycle-owned v2 runtime',
    async () => {
      const options = shellOptions({ addDirs: ['../shared'] });
      const { runV2Shell } = await vi.importActual<
        typeof import('../../src/cli/v2/run-v2-shell')
      >('../../src/cli/v2/run-v2-shell');

      await runV2Shell(options, '1.2.3-test');

      expect(mocks.createCliV2Runtime).toHaveBeenCalledExactlyOnceWith(
        options,
        '1.2.3-test',
        'shell',
        'default',
      );
      const [tui, startupInput] = mocks.tuiConstructor.mock.calls[0]!;
      expect(startupInput).toMatchObject({
        cliOptions: options,
        additionalDirs: ['../shared'],
        runtime: {
          environment: {
            homeDir: '/tmp/kimi-v2-home',
            close: expect.any(Function),
          },
        },
        migrateOnly: undefined,
        workDir: process.cwd(),
      });

      const exit = mockProcessExit();
      try {
        await expect(
          (tui as { onExit?: (code?: number) => Promise<void> }).onExit?.(0),
        ).rejects.toBeInstanceOf(ExitCalled);
      } finally {
        exit.mockRestore();
      }
      expect(mocks.runtimeClose).toHaveBeenCalledOnce();
      expect(mocks.telemetryTrack).toHaveBeenCalledWith('exit', {
        duration_ms: expect.any(Number),
      });
    },
    15_000,
  );

  it('finishes migrate-only without starting the TUI when there is no plan', async () => {
    const stdout = captureProcessWrite('stdout');
    const { runV2Shell } = await vi.importActual<
      typeof import('../../src/cli/v2/run-v2-shell')
    >('../../src/cli/v2/run-v2-shell');

    try {
      await runV2Shell(shellOptions(), '1.2.3-test', { migrateOnly: true });
    } finally {
      stdout.restore();
    }

    expect(mocks.detectPendingMigration).toHaveBeenCalledWith({
      sourceHome: expect.stringMatching(/\.kimi$/),
      targetHome: '/tmp/kimi-v2-home',
      ignoreMarker: true,
    });
    expect(mocks.tuiConstructor).not.toHaveBeenCalled();
    expect(mocks.runtimeClose).toHaveBeenCalledOnce();
    expect(stdout.text()).toContain('Nothing to migrate');
  });

  it('passes a forced migration plan into the same v2 TUI composition', async () => {
    const migrationPlan = { totalSessions: 1 };
    mocks.detectPendingMigration.mockResolvedValueOnce(migrationPlan);
    const { runV2Shell } = await vi.importActual<
      typeof import('../../src/cli/v2/run-v2-shell')
    >('../../src/cli/v2/run-v2-shell');

    await runV2Shell(shellOptions(), '1.2.3-test', { migrateOnly: true });

    const [, startupInput] = mocks.tuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      migrationPlan,
      migrateOnly: true,
      runtime: expect.any(Object),
    });
  });

  it('closes the v2 runtime exactly once when TUI startup fails', async () => {
    mocks.tuiStart.mockRejectedValueOnce(new Error('startup failed'));
    const { runV2Shell } = await vi.importActual<
      typeof import('../../src/cli/v2/run-v2-shell')
    >('../../src/cli/v2/run-v2-shell');

    await expect(runV2Shell(shellOptions(), '1.2.3-test')).rejects.toThrow(
      'startup failed',
    );

    expect(mocks.runtimeClose).toHaveBeenCalledOnce();
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('exit', {
      duration_ms: expect.any(Number),
    });
  });

  it('closes the v2 runtime when composition fails before the TUI exists', async () => {
    mocks.getConfigDiagnostics.mockRejectedValueOnce(new Error('config diagnostics failed'));
    const { runV2Shell } = await vi.importActual<
      typeof import('../../src/cli/v2/run-v2-shell')
    >('../../src/cli/v2/run-v2-shell');

    await expect(runV2Shell(shellOptions(), '1.2.3-test')).rejects.toThrow(
      'config diagnostics failed',
    );

    expect(mocks.tuiConstructor).not.toHaveBeenCalled();
    expect(mocks.runtimeClose).toHaveBeenCalledOnce();
  });
});
