import { execSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { flushDiagnosticLogsSync, log } from '@moonshot-ai/kimi-code-sdk';

import { detectPendingMigration } from '#/migration/index';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { KimiTUI } from '#/tui/index';
import { createKlientTUIRuntime } from '#/tui/runtime/tui-runtime';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { combineStartupNotice } from '#/tui/utils/startup';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import type { CLIOptions } from '../options';
import { createCliV2Runtime } from './create-v2-runtime';

/** Run the interactive TUI against the agent-core-v2 Runtime + Klient host. */
export async function runV2Shell(
  opts: CLIOptions,
  version: string,
  runOptions: { readonly migrateOnly?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  const configStartedAt = startedAt;
  let configWarning: string | undefined;
  let tuiConfig;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  currentTheme.setPalette(await getColorPalette(tuiConfig.theme));

  const workDir = process.cwd();
  const { runtime, homeDir, firstLaunch } = await createCliV2Runtime(
    opts,
    version,
    'shell',
    'default',
  );
  let closePromise: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => {
    closePromise ??= (async () => {
      runtime.telemetry.track('exit', { duration_ms: Date.now() - startedAt });
      await runtime.close();
    })();
    return closePromise;
  };
  let terminalSafety: TerminalSafety | undefined;
  try {
    const tuiRuntime = await createKlientTUIRuntime(runtime);
    const lifecycleRuntime = {
      ...tuiRuntime,
      environment: {
        ...tuiRuntime.environment,
        close: closeRuntime,
      },
    };
    for (const warning of await tuiRuntime.environment.getConfigDiagnostics()) {
      configWarning = combineStartupNotice(configWarning, warning);
    }
    const migrationPlan = await detectPendingMigration({
      sourceHome: join(homedir(), '.kimi'),
      targetHome: homeDir,
      ignoreMarker: runOptions.migrateOnly,
    });
    if (runOptions.migrateOnly === true && migrationPlan === null) {
      process.stdout.write('  Nothing to migrate from ~/.kimi/.\n');
      await closeRuntime();
      return;
    }
    const configMs = Date.now() - configStartedAt;
    const tui = new KimiTUI({
      cliOptions: opts,
      additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
      tuiConfig,
      version,
      workDir,
      startupNotice: configWarning,
      migrationPlan,
      migrateOnly: runOptions.migrateOnly,
      runtime: lifecycleRuntime,
    });

    log.info('kimi-code starting', {
      version,
      uiMode: 'shell',
      engine: 'v2',
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      workDir,
    });
    if (firstLaunch) {
      runtime.telemetry.track('first_launch');
    }

    terminalSafety = installTerminalSafety();
    tui.onExit = async (exitCode = 0) => {
      const sessionId = tui.getCurrentSessionId();
      const hasContent = tui.hasSessionContent();
      terminalSafety?.dispose();
      await closeRuntime();
      writeExitSummary(tui, sessionId, hasContent);
      if (tui.exitForegroundTask !== undefined) {
        await tui.exitForegroundTask(exitCode);
        return;
      }
      process.exit(exitCode);
    };

    const initStartedAt = Date.now();
    await tui.start();
    const initMs = Date.now() - initStartedAt;
    runtime.telemetry.track('startup_perf', {
      duration_ms: Date.now() - startedAt,
      config_ms: configMs,
      init_ms: initMs,
      mcp_ms: await tui.getStartupMcpMs(),
    });
  } catch (error) {
    terminalSafety?.dispose();
    await closeRuntime();
    throw error;
  }
}

interface InteractiveTUIExitView {
  readonly exitOpenUrl: string | undefined;
  readonly exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;
}

function writeExitSummary(
  tui: InteractiveTUIExitView,
  sessionId: string,
  hasContent: boolean,
): void {
  const gutter = ' '.repeat(CHROME_GUTTER);
  process.stdout.write(`${gutter}Bye!\n`);
  const hints: string[] = [];
  if (sessionId !== '' && hasContent) {
    hints.push(`${gutter}To resume this session: kimi -r ${sessionId}`);
  }
  if (tui.exitOpenUrl !== undefined) {
    hints.push(`${gutter}open ${toTerminalHyperlink(tui.exitOpenUrl, tui.exitOpenUrl)}`);
  }
  if (hints.length > 0) {
    process.stderr.write(`\n${hints.join('\n')}\n`);
  }
}

interface TerminalSafety {
  dispose(): void;
}

function installTerminalSafety(): TerminalSafety {
  let savedStty: string | undefined;
  try {
    const saved = execSync('stty -g', {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'ignore'],
    });
    savedStty = typeof saved === 'string' ? saved.trim() : undefined;
    execSync('stty -ixon', { stdio: ['inherit', 'ignore', 'ignore'] });
  } catch {
    // The process may not own a TTY.
  }

  const restoreStty = (): void => {
    if (savedStty === undefined) return;
    const args = savedStty.split(/\s+/).filter((arg) => arg.length > 0);
    if (args.length > 0) {
      spawnSync('stty', args, { stdio: ['inherit', 'ignore', 'ignore'] });
    }
  };
  const emergencyExit = (exitCode: number): void => {
    try {
      flushDiagnosticLogsSync();
    } catch {
      // An emergency exit must not fail while flushing diagnostics.
    }
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  const onUncaughtException = (error: unknown): void => {
    try {
      log.error('uncaughtException, restoring terminal and exiting', {
        error: String(error),
      });
    } finally {
      emergencyExit(1);
    }
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      log.error('unhandledRejection, restoring terminal and exiting', {
        reason: String(reason),
      });
    } finally {
      emergencyExit(1);
    }
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      process.off('uncaughtException', onUncaughtException);
      process.off('unhandledRejection', onUnhandledRejection);
      restoreStty();
    },
  };
}
