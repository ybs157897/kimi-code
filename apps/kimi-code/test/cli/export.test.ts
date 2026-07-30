/**
 * `kimi export`
 *
 * Verifies the CLI layer: argument handling, previous-session confirmation,
 * error reporting, and delegation to the session export implementation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { createKimiDeviceId as createKimiDeviceIdFn } from '@moonshot-ai/kimi-code-oauth';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleExport, registerExportCommand } from '#/cli/sub/export';
import type { ExportDeps } from '#/cli/sub/export';
import type {
  ExportSessionInput,
  ExportSessionManifest,
  ExportSessionResult,
  SessionSummary,
} from '@moonshot-ai/kimi-code-sdk';

let tmp: string;

type CreateKimiDeviceId = typeof createKimiDeviceIdFn;

const mocks = vi.hoisted(() => ({
  kimiHarnessConstructor: vi.fn(),
  harnessEnsureConfigFile: vi.fn(),
  harnessGetConfig: vi.fn(async () => ({
    providers: {},
    defaultModel: 'k2',
    telemetry: true,
  })),
  harnessGetCachedAccessToken: vi.fn(),
  harnessExportSession: vi.fn(),
  harnessTrack: vi.fn(),
  createKimiDeviceId: vi.fn<CreateKimiDeviceId>(() => 'device-1'),
  initializeTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
  telemetryTrack: vi.fn(),
  setTelemetryContext: vi.fn(),
  withTelemetryContext: vi.fn(),
  resolveKimiHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/kimi-export-home'),
  harnessCreatesDeviceIdOnConstruction: false,
  createCliV2Runtime: vi.fn(),
  v2SessionsList: vi.fn(
    async (): Promise<{
      items: Array<{ id: string; cwd?: string; title?: string }>;
      nextCursor?: string;
    }> => ({ items: [] }),
  ),
  v2SessionExport: vi.fn(),
  v2TelemetryTrack: vi.fn(),
  v2RuntimeClose: vi.fn(async () => {}),
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    createKimiHarness: (...args: unknown[]) => {
      const options = args[0] as { readonly homeDir?: string } | undefined;
      const homeDir = options?.homeDir ?? '/tmp/kimi-export-home';
      if (mocks.harnessCreatesDeviceIdOnConstruction) {
        mocks.createKimiDeviceId(homeDir);
      }
      mocks.kimiHarnessConstructor(...args);
      return {
        homeDir,
        auth: {
          getCachedAccessToken: mocks.harnessGetCachedAccessToken,
        },
        ensureConfigFile: mocks.harnessEnsureConfigFile,
        getConfig: mocks.harnessGetConfig,
        track: mocks.harnessTrack,
        exportSession: mocks.harnessExportSession,
      };
    },
  };
});

vi.mock('@moonshot-ai/kimi-code-oauth', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-oauth')>(
    '@moonshot-ai/kimi-code-oauth',
  );
  return {
    ...actual,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'kimi-code',
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  shutdownTelemetry: mocks.shutdownTelemetry,
  track: mocks.telemetryTrack,
  setTelemetryContext: mocks.setTelemetryContext,
  withTelemetryContext: mocks.withTelemetryContext,
}));

vi.mock('../../src/cli/v2/create-v2-runtime', () => ({
  createCliV2Runtime: mocks.createCliV2Runtime,
}));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kimi-export-'));
  mocks.createCliV2Runtime.mockResolvedValue({
    runtime: {
      klient: {
        global: {
          sessions: { list: mocks.v2SessionsList },
          sessionExport: { export: mocks.v2SessionExport },
        },
      },
      telemetry: { track: mocks.v2TelemetryTrack },
      close: mocks.v2RuntimeClose,
    },
    homeDir: '/tmp/kimi-export-home',
    firstLaunch: false,
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.harnessGetConfig.mockResolvedValue({
    providers: {},
    defaultModel: 'k2',
    telemetry: true,
  });
  mocks.createKimiDeviceId.mockImplementation(() => 'device-1');
  mocks.resolveKimiHome.mockImplementation(
    (homeDir?: string) => homeDir ?? '/tmp/kimi-export-home',
  );
  mocks.harnessCreatesDeviceIdOnConstruction = false;
  mocks.v2SessionsList.mockResolvedValue({ items: [] });
});

function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workDir: tmp,
    sessionDir: join(tmp, 'sessions', id),
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeResult(id: string, zipPath: string): ExportSessionResult {
  const manifest: ExportSessionManifest = {
    sessionId: id,
    exportedAt: '2026-04-18T12:00:00.000Z',
    kimiCodeVersion: '1.27.0',
    wireProtocolVersion: '1.0',
    os: 'test',
    nodejsVersion: '22.0.0',
    workspaceDir: tmp,
  };
  return {
    zipPath,
    entries: ['manifest.json', 'wire.jsonl'],
    sessionDir: join(tmp, 'sessions', id),
    manifest,
  };
}

function makeDeps(overrides: Partial<ExportDeps> = {}): {
  deps: ExportDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  exportInputs: ExportSessionInput[];
  listedWorkDirs: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const exportInputs: ExportSessionInput[] = [];
  const listedWorkDirs: string[] = [];
  const deps: ExportDeps = {
    listSessions: async (workDir) => {
      listedWorkDirs.push(workDir);
      return [];
    },
    exportSession: async (input) => {
      exportInputs.push(input);
      return makeResult(input.id, input.outputPath ?? join(tmp, `${input.id}.zip`));
    },
    confirmPreviousSession: async () => true,
    getInstallSource: async () => 'npm-global',
    getShellEnv: () => ({ term: 'xterm-256color', shell: '/bin/zsh' }),
    version: '1.0.0-test',
    cwd: () => tmp,
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    },
    exit: ((code: number) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    }) as ExportDeps['exit'],
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes, exportInputs, listedWorkDirs };
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

async function runExport(
  deps: ExportDeps,
  args: {
    sessionId?: string;
    output?: string;
    yes?: boolean;
    includeGlobalLog?: boolean;
  } = {},
): Promise<void> {
  try {
    await handleExport(deps, args.sessionId, args.output, {
      yes: args.yes ?? false,
      includeGlobalLog: args.includeGlobalLog ?? true,
    });
  } catch (error) {
    if (error instanceof ExitCalled) return;
    throw error;
  }
}

describe('kimi export', () => {
  it('delegates a named session export and prints the resulting zip path', async () => {
    const output = join(tmp, 'out.zip');
    const { deps, stdout, stderr, exitCodes, exportInputs, listedWorkDirs } = makeDeps();

    await runExport(deps, { sessionId: 'ses_test123456', output });

    expect(exitCodes).toEqual([]);
    expect(stderr).toEqual([]);
    expect(listedWorkDirs).toEqual([]);
    expect(exportInputs).toEqual([{ id: 'ses_test123456', outputPath: output, includeGlobalLog: true, version: '1.0.0-test', installSource: 'npm-global', shellEnv: { term: 'xterm-256color', shell: '/bin/zsh' } }]);
    expect(stdout.join('').trim()).toBe(output);
  });

  it('omits outputPath when the caller does not provide --output', async () => {
    const { deps, stdout, exportInputs } = makeDeps();

    await runExport(deps, { sessionId: 'session_default_output' });

    expect(exportInputs).toEqual([{ id: 'session_default_output', includeGlobalLog: true, version: '1.0.0-test', installSource: 'npm-global', shellEnv: { term: 'xterm-256color', shell: '/bin/zsh' } }]);
    expect(stdout.join('').trim()).toBe(join(tmp, 'session_default_output.zip'));
  });

  it('exits 1 when no session-id is provided and no previous session exists', async () => {
    const { deps, stderr, exitCodes, exportInputs, listedWorkDirs } = makeDeps();

    await runExport(deps);

    expect(listedWorkDirs).toEqual([tmp]);
    expect(exportInputs).toEqual([]);
    expect(exitCodes).toContain(1);
    expect(stderr.join('').toLowerCase()).toContain('no previous session');
  });

  it('surfaces export errors for a named session', async () => {
    const { deps, stderr, exitCodes } = makeDeps({
      exportSession: async () => {
        throw new Error('Session "ses_does_not_exist" was not found');
      },
    });

    await runExport(deps, { sessionId: 'ses_does_not_exist' });

    expect(exitCodes).toContain(1);
    expect(stderr.join('').toLowerCase()).toContain('not found');
  });

  it('falls back to the most-recent session when no id is supplied', async () => {
    const previous = makeSummary('ses_fallback');
    const output = join(tmp, 'fallback.zip');
    const { deps, stdout, exitCodes, exportInputs } = makeDeps({
      listSessions: async () => [previous],
    });

    await runExport(deps, { output });

    expect(exitCodes).toEqual([]);
    expect(exportInputs).toEqual([{ id: 'ses_fallback', outputPath: output, includeGlobalLog: true, version: '1.0.0-test', installSource: 'npm-global', shellEnv: { term: 'xterm-256color', shell: '/bin/zsh' } }]);
    expect(stdout.join('').trim()).toBe(output);
  });

  it('confirms before exporting the previous session when no id is supplied', async () => {
    const previous = makeSummary('ses_confirm', { title: 'Prod debug' });
    const summaries: unknown[] = [];
    const { deps, stdout, exitCodes, exportInputs } = makeDeps({
      listSessions: async () => [previous],
      confirmPreviousSession: async (summary) => {
        summaries.push(summary);
        return false;
      },
    });

    await runExport(deps, { output: join(tmp, 'cancelled.zip') });

    expect(exitCodes).toEqual([]);
    expect(exportInputs).toEqual([]);
    expect(stdout.join('')).toContain('Export cancelled.');
    expect(summaries).toEqual([
      {
        workDir: tmp,
        sessionId: 'ses_confirm',
        title: 'Prod debug',
      },
    ]);
  });

  it('skips previous-session confirmation with --yes', async () => {
    const previous = makeSummary('ses_yes');
    const { deps, exitCodes, exportInputs } = makeDeps({
      listSessions: async () => [previous],
      confirmPreviousSession: async () => {
        throw new Error('confirm should not be called');
      },
    });

    await runExport(deps, { output: join(tmp, 'yes.zip'), yes: true });

    expect(exitCodes).toEqual([]);
    expect(exportInputs).toEqual([{ id: 'ses_yes', outputPath: join(tmp, 'yes.zip'), includeGlobalLog: true, version: '1.0.0-test', installSource: 'npm-global', shellEnv: { term: 'xterm-256color', shell: '/bin/zsh' } }]);
  });

  it('describes the user-facing command without implementation details', () => {
    const program = new Command('kimi');
    const { deps } = makeDeps();

    registerExportCommand(program, deps);

    const command = program.commands.find((item) => item.name() === 'export');
    expect(command?.description()).toBe('Export a session as a ZIP archive.');
    expect(command?.description()).not.toMatch(/sdk/i);
  });

  it('parses --no-include-global-log as an option when no session id is given', async () => {
    const previous = makeSummary('ses_global_log');
    const { deps, stdout, exitCodes, exportInputs } = makeDeps({
      listSessions: async () => [previous],
      confirmPreviousSession: async () => true,
    });
    const program = new Command('kimi');
    registerExportCommand(program, deps);

    await program.parseAsync(['node', 'kimi', 'export', '--no-include-global-log', '-y']);

    expect(exitCodes).toEqual([]);
    expect(exportInputs).toEqual([{ id: 'ses_global_log', version: '1.0.0-test', installSource: 'npm-global', shellEnv: { term: 'xterm-256color', shell: '/bin/zsh' } }]);
    expect(stdout.join('').trim()).toBe(join(tmp, 'ses_global_log.zip'));
  });

  it('parses options after an explicit session id', async () => {
    const output = join(tmp, 'after-id.zip');
    const { deps, exitCodes, exportInputs } = makeDeps();
    const program = new Command('kimi');
    registerExportCommand(program, deps);

    await program.parseAsync([
      'node',
      'kimi',
      'export',
      'ses_after_id',
      '-o',
      output,
      '-y',
      '--no-include-global-log',
    ]);

    expect(exitCodes).toEqual([]);
    expect(exportInputs).toEqual([
      { id: 'ses_after_id', outputPath: output, version: '1.0.0-test', installSource: 'npm-global', shellEnv: { term: 'xterm-256color', shell: '/bin/zsh' } },
    ]);
  });

  it('uses one v2 runtime for the default export and closes it', async () => {
    const program = new Command('kimi');
    const output = join(tmp, 'v2.zip');
    mocks.v2SessionExport.mockResolvedValue(makeResult('ses_v2', output));

    registerExportCommand(program, {
      cwd: () => tmp,
      stdout: {
        write: () => true,
      },
      stderr: {
        write: () => true,
      },
      exit: ((code: number) => {
        throw new ExitCalled(code);
      }) as ExportDeps['exit'],
      getShellEnv: () => ({ term: 'xterm-256color', shell: '/bin/zsh' }),
    });

    await program.parseAsync(['node', 'kimi', 'export', 'ses_v2', '--output', output], {
      from: 'node',
    });

    expect(mocks.createCliV2Runtime).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: undefined, skillsDirs: [] }),
      expect.any(String),
      'shell',
      'default',
    );
    expect(mocks.v2SessionExport).toHaveBeenCalledWith({
      sessionId: 'ses_v2',
      outputPath: output,
      version: expect.any(String),
      includeGlobalLog: true,
      installSource: expect.any(String),
      shellEnv: expect.objectContaining({ shell: expect.any(String) }),
    });
    expect(mocks.v2RuntimeClose).toHaveBeenCalledOnce();
    expect(mocks.kimiHarnessConstructor).not.toHaveBeenCalled();
  });

  it('paginates the v2 session index when resolving the previous session', async () => {
    const program = new Command('kimi');
    const output = join(tmp, 'previous.zip');
    const stdout: string[] = [];
    mocks.v2SessionsList
      .mockResolvedValueOnce({
        items: [{ id: 'ses_other', cwd: '/tmp/other' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'ses_previous', cwd: `${tmp}/.`, title: 'Previous' }],
      });
    mocks.v2SessionExport.mockResolvedValue(makeResult('ses_previous', output));

    registerExportCommand(program, {
      cwd: () => tmp,
      stdout: { write: (chunk) => stdout.push(chunk) > 0 },
      stderr: { write: () => true },
      exit: ((code: number) => {
        throw new ExitCalled(code);
      }) as ExportDeps['exit'],
    });

    await program.parseAsync(['node', 'kimi', 'export', '--yes', '--output', output], {
      from: 'node',
    });

    expect(mocks.v2SessionsList.mock.calls).toEqual([
      [{ cursor: undefined, limit: 100 }],
      [{ cursor: 'page-2', limit: 100 }],
    ]);
    expect(mocks.v2SessionExport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_previous', outputPath: output }),
    );
    expect(stdout.join('')).toContain(output);
    expect(mocks.v2RuntimeClose).toHaveBeenCalledOnce();
  });

  it('closes the v2 runtime when export fails', async () => {
    const program = new Command('kimi');
    mocks.v2SessionExport.mockRejectedValue(new Error('export failed'));

    registerExportCommand(program, {
      cwd: () => tmp,
      stdout: {
        write: () => true,
      },
      stderr: {
        write: () => true,
      },
      exit: ((code: number) => {
        throw new ExitCalled(code);
      }) as ExportDeps['exit'],
    });

    await expect(
      program.parseAsync(['node', 'kimi', 'export', 'ses_failed'], {
        from: 'node',
      }),
    ).rejects.toThrow(ExitCalled);

    expect(mocks.v2RuntimeClose).toHaveBeenCalledOnce();
  });

  it('tracks first launch through the v2 runtime before exporting', async () => {
    const program = new Command('kimi');
    const output = join(tmp, 'first-launch.zip');
    mocks.createCliV2Runtime.mockResolvedValueOnce({
      runtime: {
        klient: {
          global: {
            sessions: { list: mocks.v2SessionsList },
            sessionExport: { export: mocks.v2SessionExport },
          },
        },
        telemetry: { track: mocks.v2TelemetryTrack },
        close: mocks.v2RuntimeClose,
      },
      homeDir: '/tmp/kimi-export-home',
      firstLaunch: true,
    });
    mocks.v2SessionExport.mockResolvedValue(makeResult('ses_first_launch', output));

    registerExportCommand(program, {
      cwd: () => tmp,
      stdout: {
        write: () => true,
      },
      stderr: {
        write: () => true,
      },
      exit: ((code: number) => {
        throw new ExitCalled(code);
      }) as ExportDeps['exit'],
    });

    await program.parseAsync(['node', 'kimi', 'export', 'ses_first_launch', '--output', output], {
      from: 'node',
    });

    expect(mocks.v2TelemetryTrack).toHaveBeenCalledWith('first_launch');
    expect(mocks.v2TelemetryTrack.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.v2SessionExport.mock.invocationCallOrder[0]!,
    );
  });
});
