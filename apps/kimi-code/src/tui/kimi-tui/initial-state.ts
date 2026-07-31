/**
 * The KimiTUI startup input contract and the initial AppState derived from
 * it.
 */

import type { MigrationPlan } from '@moonshot-ai/migration-legacy';

import type { CLIOptions } from '#/cli/options';
import type { TuiConfig } from '#/tui/config';
import type { RuntimeEnvironmentPort } from '#/tui/runtime/runtime-environment-port';
import type { RuntimeTelemetryPort } from '#/tui/runtime/runtime-telemetry-port';
import type { AgentPermissionMode, SessionControlPort } from '#/tui/runtime/session-control-port';
import type { TUIRuntime } from '#/tui/runtime/tui-runtime';
import type { AppState } from '#/tui/types';

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly migrationPlan?: MigrationPlan | null;
  /** When true, run only the migration screen, then exit (the `kimi migrate` command). */
  readonly migrateOnly?: boolean;
  readonly runtime: TUIRuntime;
  readonly runtimeEnvironment?: RuntimeEnvironmentPort;
  readonly runtimeTelemetry?: RuntimeTelemetryPort;
  readonly sessionControl?: SessionControlPort;
}

export function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: AgentPermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    additionalDirs: [...(input.additionalDirs ?? [])],
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    inputMode: 'prompt',
    swarmMode: false,
    expertTeam: null,
    expertTeamMembers: [],
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}
