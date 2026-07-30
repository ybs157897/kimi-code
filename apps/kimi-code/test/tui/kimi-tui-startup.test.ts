import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log, type GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import { describe, expect, it, vi } from 'vitest';

import { BannerProvider } from '#/tui/banner/banner-provider';
import { readBannerDisplayState } from '#/tui/banner/state';
import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import { promptPlatformSelection, promptLogoutProviderSelection } from '#/tui/commands/prompts';
import { BannerComponent } from '#/tui/components/chrome/banner';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import type { ExtensionCommandPort } from '#/tui/runtime/extension-command-port';
import type { RuntimeEnvironmentPort } from '#/tui/runtime/runtime-environment-port';
import type { RuntimeModelCatalogPort } from '#/tui/runtime/runtime-model-catalog-port';
import type { RuntimeSessionExportPort } from '#/tui/runtime/runtime-session-export-port';
import type { RuntimeTelemetryPort, RuntimeTelemetryProperties } from '#/tui/runtime/runtime-telemetry-port';
import type { AgentEventsPort } from '#/tui/runtime/agent-events-port';
import type { SessionScopedEventsPort } from '#/tui/runtime/session-events-port';
import type { AgentRuntimeStatus, SessionControlPort, SessionIdentity } from '#/tui/runtime/session-control-port';
import type { SessionMcpPort } from '#/tui/runtime/session-mcp-port';
import type { SessionSkillsPort } from '#/tui/runtime/session-skills-port';
import type { SessionWarningsPort, SessionWarningView } from '#/tui/runtime/session-warnings-port';
import type { SessionWorkspacePort } from '#/tui/runtime/session-workspace-port';
import type { TUIRuntime } from '#/tui/runtime/tui-runtime';
import type { TUISessionRuntime } from '#/tui/runtime/tui-session-runtime';
import { REPLAY_TURN_LIMIT } from '#/tui/utils/message-replay';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { quoteShellArg } from '#/utils/shell-quote';
import {
  DISABLE_TERMINAL_THEME_REPORTING,
  ENABLE_TERMINAL_THEME_REPORTING,
  OSC11_QUERY,
  QUERY_TERMINAL_THEME,
  TERMINAL_THEME_LIGHT,
} from '#/tui/utils/terminal-theme';

vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return {
    ...actual,
    promptPlatformSelection: vi.fn(),
    promptLogoutProviderSelection: vi.fn(),
  };
});
vi.mock('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));

const copyTextToClipboardMock = vi.mocked(copyTextToClipboard);

interface StartupDriver {
  readonly authFlow: {
    refreshAvailableModels(): Promise<void>;
    refreshConfigAfterLogin(): Promise<void>;
    refreshConfigAfterLogout(): Promise<void>;
  };
  readonly runtime: TUIRuntime;
  readonly runtimeEnvironment: RuntimeEnvironmentPort;
  readonly runtimeTelemetry: RuntimeTelemetryPort;
  readonly sessionControl: SessionControlPort;
  readonly extensionCommandNames: ReadonlySet<string>;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly sessionEventHandler: {
    startSubscription(): void;
  };
  state: TUIState;
  session: unknown | undefined;
  init(): Promise<boolean>;
  handleLoginCommand(): Promise<void>;
  handleLogoutCommand(): Promise<void>;
  refreshExtensionCommands(): Promise<void>;
  refreshSkillCommands(): Promise<void>;
  getStartupMcpMs(): Promise<number>;
  requireSessionRuntime(): TUISessionRuntime;
  reloadCurrentSessionView(statusMessage: string): Promise<void>;
  closeSession(reason: string): Promise<void>;
  stop(exitCode?: number): Promise<void>;
  track(event: string, properties?: RuntimeTelemetryProperties): void;
}

interface FinishStartupDriver extends StartupDriver {
  finishStartup(shouldReplayHistory: boolean): Promise<void>;
}

interface ThemeTrackingDriver extends StartupDriver {
  refreshTerminalThemeTracking(): void;
}

interface MigrateExitDriver extends StartupDriver {
  start(): Promise<void>;
  onExit?: (code?: number) => Promise<void>;
  runMigrationScreen(plan: unknown): Promise<unknown>;
  initMainTui(): Promise<boolean>;
  terminalFocusTrackingDispose?: () => void;
}

const MIGRATION_PLAN: MigrationPlan = {
  sourceHome: '/x/.kimi',
  hasConfig: false,
  hasMcp: false,
  hasUserHistory: false,
  oauthCredentials: [],
  workdirs: [],
  detectedPlugins: [],
  detectedMcpOauthServers: [],
  totalSessions: 0,
};

function makeStartupInput(
  cliOptions: Partial<KimiTUIStartupInput['cliOptions']> = {},
  tuiConfig: Partial<KimiTUIStartupInput['tuiConfig']> = {},
  runtimeInput: Parameters<typeof makeTUIRuntime>[0] = {},
): KimiTUIStartupInput {
  return {
    cliOptions: {
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
      ...cliOptions,
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      ...tuiConfig,
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
    runtime: makeTUIRuntime(runtimeInput).runtime,
  };
}

interface SessionFixture {
  readonly identity: SessionIdentity;
  readonly getStatus: TUISessionRuntime['agent']['getStatus'];
  readonly setModel: TUISessionRuntime['agent']['setModel'];
  readonly setThinking: TUISessionRuntime['agent']['setThinking'];
  readonly setPermission: TUISessionRuntime['agent']['setPermission'];
  readonly setPlanMode: TUISessionRuntime['agent']['setPlanMode'];
  readonly getGoal: TUISessionRuntime['agent']['getGoal'];
  readonly getSessionWarnings: SessionWarningsPort['list'];
  readonly getResumeState: () => unknown;
  readonly close: TUISessionRuntime['lifecycle']['close'];
}

interface SessionFixtureOverrides {
  readonly id?: string;
  readonly workDir?: string;
  readonly title?: string;
  readonly getStatus?: ReturnType<typeof vi.fn>;
  readonly setModel?: SessionFixture['setModel'];
  readonly setThinking?: SessionFixture['setThinking'];
  readonly setPermission?: SessionFixture['setPermission'];
  readonly setPlanMode?: SessionFixture['setPlanMode'];
  readonly getGoal?: SessionFixture['getGoal'];
  readonly getSessionWarnings?: SessionFixture['getSessionWarnings'];
  readonly getResumeState?: SessionFixture['getResumeState'];
  readonly close?: SessionFixture['close'];
}

function makeSession(overrides: SessionFixtureOverrides = {}): SessionFixture {
  const id = overrides.id ?? 'ses-1';
  return {
    identity: {
      id,
      workDir: overrides.workDir ?? '/tmp/proj-a',
      title: overrides.title ?? 'Session title',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    },
    getStatus:
      (overrides.getStatus as SessionFixture['getStatus'] | undefined) ??
      vi.fn(
        async (): Promise<AgentRuntimeStatus> => ({
          model: 'k2',
          thinkingEffort: 'off',
          permission: 'manual',
          planMode: false,
          contextTokens: 10,
          maxContextTokens: 100,
          contextUsage: 0.1,
        }),
      ),
    setModel: overrides.setModel ?? vi.fn(async () => {}),
    setThinking: overrides.setThinking ?? vi.fn(async () => {}),
    setPermission: overrides.setPermission ?? vi.fn(async () => {}),
    setPlanMode: overrides.setPlanMode ?? vi.fn(async () => {}),
    getGoal: overrides.getGoal ?? vi.fn(async () => null),
    getSessionWarnings: overrides.getSessionWarnings ?? vi.fn(async () => []),
    getResumeState: overrides.getResumeState ?? vi.fn(() => undefined),
    close: overrides.close ?? vi.fn(async () => {}),
  };
}

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective: 'Ship feature X',
    status: 'paused',
    turnsUsed: 2,
    tokensUsed: 100,
    wallClockMs: 1000,
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

function createResumeState(overrides: { permissionMode?: string; planMode?: boolean } = {}) {
  return {
    id: 'ses-latest',
    workDir: '/tmp/proj-a',
    sessionDir: '/tmp/proj-a/.kimi/sessions/ses-latest',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionMetadata: {},
    agents: {
      main: {
        type: 'main',
        config: {
          cwd: '/tmp/proj-a',
          modelCapabilities: { max_context_tokens: 100 },
          thinkingEffort: 'off',
          systemPrompt: '',
        },
        context: { history: [], tokenCount: 10 },
        replay: [],
        permission: { mode: overrides.permissionMode ?? 'manual', rules: [] },
        plan: overrides.planMode ? { id: 'plan-1', content: '', path: '/tmp/plan.md' } : null,
        swarmMode: false,
        usage: {},
        tools: [],
        background: [],
      },
    },
  } as never;
}

function loginRequiredError(): Error & { readonly code: string } {
  return Object.assign(new Error('OAuth provider "managed:kimi-code" requires login.'), {
    code: 'auth.login_required',
  });
}

function makeManagedModels(): RuntimeModelCatalogPort {
  return {
    load: vi.fn(async () => ({
      defaultModel: 'k2',
      models: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'moonshot-v1',
          maxContextSize: 100,
        },
      },
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          status: 'connected' as const,
          hasApiKey: true,
        },
      },
    })),
  };
}

function makeTUIRuntime(
  input: {
    environment?: RuntimeEnvironmentPort;
    telemetry?: RuntimeTelemetryPort;
    sessionControl?: SessionControlPort;
    models?: RuntimeModelCatalogPort;
    sessionExport?: RuntimeSessionExportPort;
    extensionCommands?: ExtensionCommandPort;
    sessionEvents?: SessionScopedEventsPort;
    agentEvents?: AgentEventsPort;
    mcp?: SessionMcpPort;
    skills?: SessionSkillsPort;
    warnings?: SessionWarningsPort;
    workspace?: SessionWorkspacePort;
    sessions?: readonly SessionFixture[];
    listSessions?: SessionControlPort['sessions']['list'];
    createSession?: SessionControlPort['sessions']['create'];
    resumeSession?: SessionControlPort['sessions']['resume'];
    auth?: Partial<TUIRuntime['auth']>;
    modelConfig?: TUIRuntime['modelConfig'];
  } = {},
) {
  const environment =
    input.environment ??
    ({
      homeDir: '/tmp/runtime-home',
      getExperimentalFeatures: vi.fn(async () => []),
      getConfigDiagnostics: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    } satisfies RuntimeEnvironmentPort);
  const telemetry =
    input.telemetry ??
    ({
      track: vi.fn(),
      setContext: vi.fn(),
    } satisfies RuntimeTelemetryPort);
  const sessionIdentity = (id: string): SessionIdentity => ({
    id,
    workDir: '/tmp/proj-a',
    title: 'Session title',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  });
  const defaultSession = makeSession();
  const sessionFixtures = input.sessions ?? [defaultSession];
  const fixtureById = new Map(sessionFixtures.map((fixture) => [fixture.identity.id, fixture]));
  const fixtureFor = (sessionId: string): SessionFixture => fixtureById.get(sessionId) ?? defaultSession;
  const makeAgent = (fixture: SessionFixture): TUISessionRuntime['agent'] =>
    ({
      prompt: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      runShellCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      cancelShellCommand: vi.fn(async () => {}),
      getStatus: fixture.getStatus,
      getModel: vi.fn(async () => (await fixture.getStatus()).model),
      setModel: fixture.setModel,
      getThinking: vi.fn(async () => (await fixture.getStatus()).thinkingEffort),
      setThinking: fixture.setThinking,
      setPermission: fixture.setPermission,
      getPlan: vi.fn(async () => null),
      setPlanMode: fixture.setPlanMode,
      clearPlan: vi.fn(async () => {}),
      getGoal: fixture.getGoal,
      createGoal: vi.fn(),
      pauseGoal: vi.fn(),
      resumeGoal: vi.fn(),
      cancelGoal: vi.fn(),
      listTasks: vi.fn(async () => []),
      detachTask: vi.fn(async () => undefined),
      getTaskOutput: vi.fn(async () => ''),
      stopTask: vi.fn(async () => {}),
    } as TUISessionRuntime['agent']);
  const sessionControl: SessionControlPort =
    input.sessionControl ??
    ({
      sessions: {
        list:
          input.listSessions ??
          vi.fn(async (query = {}) =>
            sessionFixtures
              .map((fixture) => fixture.identity)
              .filter(
                (identity) =>
                  (query.sessionId === undefined || identity.id === query.sessionId) &&
                  (query.workDir === undefined || identity.workDir === query.workDir),
              ),
          ),
        create: input.createSession ?? vi.fn(async () => sessionFixtures[0]?.identity ?? sessionIdentity('ses-1')),
        resume: input.resumeSession ?? vi.fn(async ({ id }) => fixtureById.get(id)?.identity),
      },
      session: vi.fn((sessionId: string) => {
        const fixture = fixtureFor(sessionId);
        return {
          getIdentity: vi.fn(async () => (fixtureById.has(sessionId) ? fixture.identity : sessionIdentity(sessionId))),
          close: fixture.close,
          setTitle: vi.fn(async () => {}),
          fork: vi.fn(async () => sessionIdentity(`${sessionId}-fork`)),
        };
      }),
      agent: vi.fn((sessionId: string) => makeAgent(fixtureFor(sessionId))),
    } satisfies SessionControlPort);
  const models =
    input.models ??
    ({
      load: vi.fn(async () => ({ models: {}, providers: {} })),
    } satisfies RuntimeModelCatalogPort);
  const modelConfig =
    input.modelConfig ??
    ({
      apply: vi.fn(async () => {}),
      removeProvider: vi.fn(async () => {}),
    } satisfies TUIRuntime['modelConfig']);
  const sessionExport =
    input.sessionExport ??
    ({
      export: vi.fn(async () => ({
        zipPath: '/tmp/example-session.zip',
        entries: ['manifest.json'],
        manifest: {
          sessionId: 'ses-1',
          exportedAt: '2026-07-27T00:00:00.000Z',
          kimiCodeVersion: '1.2.3',
          wireProtocolVersion: '1',
          os: 'example-os',
          nodejsVersion: 'v24.15.0',
        },
      })),
    } satisfies RuntimeSessionExportPort);
  const extensionCommands =
    input.extensionCommands ??
    ({
      list: vi.fn(async () => []),
      reload: vi.fn(async () => {}),
      activate: vi.fn(async () => undefined),
    } satisfies ExtensionCommandPort);
  const sessionEvents =
    input.sessionEvents ??
    ({
      subscribe: vi.fn(() => vi.fn()),
      respondToApproval: vi.fn(async () => {}),
      respondToQuestion: vi.fn(async () => {}),
    } satisfies SessionScopedEventsPort);
  const defaultAgentEvents =
    input.agentEvents ??
    ({
      sessionId: 'ses-1',
      agentId: 'main',
      subscribe: vi.fn(() => vi.fn()),
      readReplay: vi.fn(async () => defaultSession.getResumeState() as never),
    } satisfies AgentEventsPort);
  const mcp =
    input.mcp ??
    ({
      list: vi.fn(async () => []),
      reconnect: vi.fn(async () => {}),
      initialLoadDurationMs: vi.fn(async () => 0),
    } satisfies SessionMcpPort);
  const skills =
    input.skills ??
    ({
      list: vi.fn(async () => []),
      reload: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
    } satisfies SessionSkillsPort);
  const warnings =
    input.warnings ??
    ({
      list: vi.fn(async () => []),
    } satisfies SessionWarningsPort);
  const workspace =
    input.workspace ??
    ({
      get: vi.fn(async () => ({ workDir: '/tmp/proj-a', additionalDirs: [] })),
      addAdditionalDir: vi.fn(async () => ({
        projectRoot: '/tmp/proj-a',
        configPath: '/tmp/proj-a/.kimi/config.toml',
        additionalDirs: [],
        persisted: true,
      })),
    } satisfies SessionWorkspacePort);
  const expertTeam = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    activate: vi.fn(),
    deactivate: vi.fn(async () => {}),
  } as unknown as TUISessionRuntime['expertTeam'];
  const runtimeByKey = new Map<string, TUISessionRuntime>();
  const makeSessionRuntime = (sessionId: string, agentId = 'main'): TUISessionRuntime => {
    const key = `${sessionId}:${agentId}`;
    const cached = runtimeByKey.get(key);
    if (cached !== undefined) return cached;
    const fixture = fixtureFor(sessionId);
    const boundAgentEvents = {
      ...defaultAgentEvents,
      sessionId,
      agentId,
      readReplay: vi.fn(async () => fixture.getResumeState() as never),
    };
    const boundWarnings = {
      list: fixture.getSessionWarnings,
    } satisfies SessionWarningsPort;
    const runtime = {
      sessionId,
      agentId,
      lifecycle: sessionControl.session(sessionId),
      agent: sessionControl.agent(sessionId, agentId),
      expertTeam,
      sessionEvents,
      agentEvents: boundAgentEvents,
      mcp,
      extensionCommands,
      skills,
      warnings: input.warnings ?? boundWarnings,
      workspace,
    } as unknown as TUISessionRuntime;
    runtimeByKey.set(key, runtime);
    return runtime;
  };
  const sessionRuntime = makeSessionRuntime(defaultSession.identity.id);
  const bindSession = vi.fn(makeSessionRuntime);
  const runtime = {
    auth: {
      status: vi.fn(async () => ({ loggedIn: false })),
      login: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      ensureReady: vi.fn(async () => {}),
      getManagedUsage: vi.fn(async () => ({
        kind: 'error' as const,
        message: 'Not configured in this test.',
      })),
      submitFeedback: vi.fn(async () => ({
        kind: 'ok' as const,
        feedbackId: 3,
      })),
      createFeedbackUploadUrl: vi.fn(async () => ({
        kind: 'error' as const,
        message: 'Not configured in this test.',
      })),
      completeFeedbackUpload: vi.fn(async () => ({
        kind: 'error' as const,
        message: 'Not configured in this test.',
      })),
      ...input.auth,
    },
    environment,
    localMedia: {
      getImageMaxEdgePx: vi.fn(async () => undefined),
      persistOriginalImage: vi.fn(async () => null),
    },
    featureFlags: {
      list: vi.fn(async () => []),
      apply: vi.fn(async () => []),
    },
    models,
    modelConfig,
    providerRefresh: {
      refresh: vi.fn(async () => ({ changed: [], unchanged: [], failed: [] })),
    },
    sessionExport,
    telemetry,
    sessionControl,
    bindSession,
  } satisfies TUIRuntime;
  return {
    runtime,
    environment,
    telemetry,
    sessionControl,
    models,
    sessionRuntime,
    sessionEvents,
    agentEvents: defaultAgentEvents,
    mcp,
    extensionCommands,
    skills,
    warnings,
    workspace,
    bindSession,
  };
}

function makeDriver(input: KimiTUIStartupInput) {
  const driver = new KimiTUI(input) as unknown as StartupDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  return driver;
}

type InputListener = Parameters<TUIState['ui']['addInputListener']>[0];
const DARK_OSC11_REPORT = '\u001B]11;rgb:2828/2c2c/3434\u0007';
const LIGHT_OSC11_REPORT = '\u001B]11;rgb:fafa/fbfb/fcfc\u0007';

function captureInputListeners(driver: StartupDriver) {
  const listeners: InputListener[] = [];
  const removeInputListener = vi.fn<() => void>();
  const write = vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
  const addInputListener = vi
    .spyOn(driver.state.ui, 'addInputListener')
    .mockImplementation((listener: InputListener) => {
      listeners.push(listener);
      return removeInputListener;
    });

  return { listeners, removeInputListener, write, addInputListener };
}

describe('KimiTUI startup', () => {
  it('selects process ports from an injected runtime when overrides are absent', () => {
    const { runtime, environment, telemetry, sessionControl } = makeTUIRuntime();
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    expect(driver.runtime).toBe(runtime);
    expect(driver.runtimeEnvironment).toBe(environment);
    expect(driver.runtimeTelemetry).toBe(telemetry);
    expect(driver.sessionControl).toBe(sessionControl);
  });

  it('prefers explicit process port overrides to the injected runtime', () => {
    const { runtime } = makeTUIRuntime();
    const runtimeEnvironment = {
      homeDir: '/tmp/override-home',
      getExperimentalFeatures: vi.fn(async () => []),
      getConfigDiagnostics: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    } satisfies RuntimeEnvironmentPort;
    const runtimeTelemetry = {
      track: vi.fn(),
      setContext: vi.fn(),
    } satisfies RuntimeTelemetryPort;
    const sessionControl = {} as SessionControlPort;
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
      runtimeEnvironment,
      runtimeTelemetry,
      sessionControl,
    });

    expect(driver.runtimeEnvironment).toBe(runtimeEnvironment);
    expect(driver.runtimeTelemetry).toBe(runtimeTelemetry);
    expect(driver.sessionControl).toBe(sessionControl);
  });

  it('loads the available model catalog through an injected runtime', async () => {
    const models = {
      load: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'moonshot-v1',
            maxContextSize: 128_000,
          },
        },
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            status: 'connected' as const,
            hasApiKey: true,
          },
        },
      })),
    } satisfies RuntimeModelCatalogPort;
    const { runtime } = makeTUIRuntime({ models });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    await driver.authFlow.refreshAvailableModels();

    expect(models.load).toHaveBeenCalledWith({ reload: true });
    expect(driver.state.appState).toMatchObject({
      availableModels: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'moonshot-v1',
          maxContextSize: 128_000,
        },
      },
      availableProviders: {
        'managed:kimi-code': {
          type: 'kimi',
        },
      },
    });
  });

  it('binds the startup session through an injected runtime', async () => {
    const session = makeSession();
    const { runtime, sessionRuntime, bindSession } = makeTUIRuntime();
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    await expect(driver.init()).resolves.toBe(false);

    expect(bindSession).toHaveBeenCalledWith('ses-1', 'main');
    expect(driver.requireSessionRuntime()).toBe(sessionRuntime);
  });

  it('reads startup MCP duration through the active session runtime', async () => {
    const legacyMetrics = vi.fn(async () => ({ durationMs: 999 }));
    const mcp = {
      list: vi.fn(async () => []),
      reconnect: vi.fn(async () => {}),
      initialLoadDurationMs: vi.fn(async () => 37),
    } satisfies SessionMcpPort;
    const { runtime } = makeTUIRuntime({ mcp });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });
    await driver.init();

    await expect(driver.getStartupMcpMs()).resolves.toBe(37);

    expect(mcp.initialLoadDurationMs).toHaveBeenCalledOnce();
    expect(legacyMetrics).not.toHaveBeenCalled();
  });

  it('reports zero startup MCP duration without an active session binding', async () => {
    const mcp = {
      list: vi.fn(async () => []),
      reconnect: vi.fn(async () => {}),
      initialLoadDurationMs: vi.fn(async () => 37),
    } satisfies SessionMcpPort;
    const { runtime } = makeTUIRuntime({ mcp });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    await expect(driver.getStartupMcpMs()).resolves.toBe(0);

    expect(mcp.initialLoadDurationMs).not.toHaveBeenCalled();
  });

  it('reports zero startup MCP duration when the active runtime cannot load metrics', async () => {
    const mcp = {
      list: vi.fn(async () => []),
      reconnect: vi.fn(async () => {}),
      initialLoadDurationMs: vi.fn(async () => {
        throw new Error('metrics unavailable');
      }),
    } satisfies SessionMcpPort;
    const { runtime } = makeTUIRuntime({ mcp });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });
    await driver.init();

    await expect(driver.getStartupMcpMs()).resolves.toBe(0);
  });

  it('refreshes skill commands through the active binding when the raw session is absent', async () => {
    const skills = {
      list: vi.fn(async () => [
        {
          name: 'review',
          description: 'Review the current changes',
          path: '/skills/review/SKILL.md',
          source: 'user' as const,
        },
      ]),
      reload: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
    } satisfies SessionSkillsPort;
    const { runtime } = makeTUIRuntime({ skills });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });
    await driver.init();
    driver.session = undefined;

    await driver.refreshSkillCommands();

    expect(driver.skillCommandMap.get('skill:review')).toBe('review');
  });

  it('maps runtime warning severities after startup when the raw session is unavailable', async () => {
    const warnings = {
      list: vi.fn(async () => [
        {
          code: 'runtime.notice',
          message: 'Runtime notice',
          severity: 'info' as const,
        },
        {
          code: 'runtime.failure',
          message: 'Runtime failure',
          severity: 'error' as const,
        },
      ]),
    } satisfies SessionWarningsPort;
    const session = makeSession();
    const { runtime } = makeTUIRuntime({ warnings });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    }) as unknown as FinishStartupDriver;
    const showStatus = vi.spyOn(driver as any, 'showStatus');

    await driver.init();
    driver.session = undefined;
    await driver.finishStartup(false);

    await vi.waitFor(() => {
      expect(warnings.list).toHaveBeenCalledOnce();
    });
    expect(session.getSessionWarnings).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith('Warning: Runtime notice', 'warning');
    expect(showStatus).toHaveBeenCalledWith('Warning: Runtime failure', 'error');
  });

  it('shows warnings through the default session runtime composition', async () => {
    const getSessionWarnings = vi.fn(async () => [
      {
        code: 'legacy.notice',
        message: 'Legacy notice',
        severity: 'warning' as const,
      },
    ]);
    const session = makeSession({ getSessionWarnings });
    const driver = makeDriver(makeStartupInput({}, {}, { sessions: [session] })) as unknown as FinishStartupDriver;
    const showStatus = vi.spyOn(driver as any, 'showStatus');

    await driver.init();
    await driver.finishStartup(false);

    await vi.waitFor(() => {
      expect(getSessionWarnings).toHaveBeenCalledOnce();
    });
    expect(showStatus).toHaveBeenCalledWith('Warning: Legacy notice', 'warning');
  });

  it('ignores runtime warning failures while reloading the session view', async () => {
    const warnings = {
      list: vi.fn(async () => {
        throw new Error('warnings unavailable');
      }),
    } satisfies SessionWarningsPort;
    const getSessionWarnings = vi.fn(async () => [
      {
        code: 'legacy.notice',
        message: 'Legacy warning',
        severity: 'warning' as const,
      },
    ]);
    const session = makeSession({ getSessionWarnings });
    const { runtime } = makeTUIRuntime({ warnings });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    }) as unknown as StartupDriver;
    const showStatus = vi.spyOn(driver as any, 'showStatus');
    await driver.init();

    await expect(driver.reloadCurrentSessionView('Session reloaded.')).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(warnings.list).toHaveBeenCalledOnce();
    });

    expect(getSessionWarnings).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith('Session reloaded.');
    expect(showStatus).not.toHaveBeenCalledWith('Warning: Legacy warning', 'warning');
  });

  it('reads extension commands from the active session runtime', async () => {
    const session = makeSession();
    const list = vi.fn(async () => [{ extensionId: 'review', name: 'check', description: 'Review changes' }]);
    const extensionCommands = {
      list,
      reload: vi.fn(async () => {}),
      activate: vi.fn(async () => undefined),
    } satisfies ExtensionCommandPort;
    const { runtime } = makeTUIRuntime({ extensionCommands });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    await expect(driver.init()).resolves.toBe(false);
    await driver.refreshExtensionCommands();

    expect(list).toHaveBeenCalled();
    expect(driver.extensionCommandNames).toContain('review:check');
  });

  it('clears the active session runtime when the session closes', async () => {
    const session = makeSession();
    const { runtime } = makeTUIRuntime();
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    }) as unknown as StartupDriver;

    await expect(driver.init()).resolves.toBe(false);
    await driver.closeSession('test close');

    expect(() => driver.requireSessionRuntime()).toThrow('No active session. Send /login to login.');
  });

  it('reads process capabilities from an injected runtime environment', async () => {
    const runtimeEnvironment = {
      homeDir: '/tmp/runtime-home',
      getExperimentalFeatures: vi.fn(async () => []),
      getConfigDiagnostics: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    } satisfies RuntimeEnvironmentPort;
    const driver = makeDriver({
      ...makeStartupInput(),
      runtimeEnvironment,
    });

    await expect(driver.init()).resolves.toBe(false);

    expect(runtimeEnvironment.getExperimentalFeatures).toHaveBeenCalledOnce();
  });

  it('delegates event tracking to an injected runtime telemetry port', () => {
    const runtimeTelemetry = {
      track: vi.fn(),
      setContext: vi.fn(),
    } satisfies RuntimeTelemetryPort;
    const driver = makeDriver({
      ...makeStartupInput(),
      runtimeTelemetry,
    });

    driver.track('startup_test', { source: 'test' });

    expect(runtimeTelemetry.track).toHaveBeenCalledWith('startup_test', {
      source: 'test',
    });
  });

  it('publishes each session context transition through injected runtime telemetry', async () => {
    const session = makeSession();
    const runtimeTelemetry = {
      track: vi.fn(),
      setContext: vi.fn(),
    } satisfies RuntimeTelemetryPort;
    const driver = makeDriver({
      ...makeStartupInput(),
      runtimeTelemetry,
    }) as unknown as StartupDriver;

    await expect(driver.init()).resolves.toBe(false);

    expect(runtimeTelemetry.setContext.mock.calls).toEqual([[{ sessionId: null }], [{ sessionId: 'ses-1' }]]);

    runtimeTelemetry.setContext.mockClear();
    await driver.reloadCurrentSessionView('Session reloaded.');
    await driver.closeSession('test close');

    expect(runtimeTelemetry.setContext.mock.calls).toEqual([[{ sessionId: 'ses-1' }], [{ sessionId: null }]]);
  });

  it('creates a fresh session from startup flags and syncs runtime state', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'yolo',
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 200,
        contextUsage: 0.125,
      })),
    });
    const driver = makeDriver(makeStartupInput({ yolo: true, plan: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
      contextTokens: 25,
      maxContextTokens: 200,
      contextUsage: 0.125,
      sessionTitle: 'Session title',
    });
  });

  it('resumes the latest session for --continue and marks history for replay', async () => {
    const session = makeSession({ id: 'ses-latest' });
    const driver = makeDriver(makeStartupInput({ continue: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('ses-latest');
  });

  it('applies --auto permission when resuming a session via --continue', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, auto: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('applies --yolo permission when resuming a session via --continue', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, yolo: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(driver.state.appState.permissionMode).toBe('yolo');
  });

  it('applies --plan mode when resuming a session via --continue', async () => {
    let planMode = false;
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async (enabled: boolean) => {
        planMode = enabled;
      }),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, plan: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('skips setPlanMode when the resumed session is already in plan mode', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, plan: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('forces footer state to reflect --auto even if getStatus lags behind', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async () => {}),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, auto: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('forces footer state to reflect --plan even if getStatus lags behind', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPlanMode: vi.fn(async () => {}),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, plan: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('keeps --auto in the footer after session replay hydration', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getResumeState: vi.fn(() => createResumeState({ permissionMode: 'manual', planMode: false })),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, auto: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);
    await (
      driver as unknown as {
        finishStartup(shouldReplayHistory: boolean): Promise<void>;
      }
    ).finishStartup(true);

    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('keeps --plan in the footer after session replay hydration', async () => {
    const session = makeSession({
      id: 'ses-latest',
      getResumeState: vi.fn(() => createResumeState({ permissionMode: 'manual', planMode: false })),
    });
    const driver = makeDriver(makeStartupInput({ continue: true, plan: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);
    await (
      driver as unknown as {
        finishStartup(shouldReplayHistory: boolean): Promise<void>;
      }
    ).finishStartup(true);

    expect(driver.state.appState.planMode).toBe(true);
  });

  it('applies --auto permission when resuming an explicit session', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-target',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const driver = makeDriver(makeStartupInput({ session: 'ses-target', auto: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(driver.state.appState.permissionMode).toBe('auto');
  });

  it('syncs a persisted goal when resuming a session', async () => {
    const goal = goalSnapshot({
      status: 'blocked',
      terminalReason: 'needs input',
    });
    const session = makeSession({
      id: 'ses-latest',
      getGoal: vi.fn(async () => goal),
    });
    const driver = makeDriver(makeStartupInput({ continue: true }, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(true);

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(driver.state.appState.goal).toEqual(goal);
  });

  it('syncs goal state regardless of the goal flag', async () => {
    const goal = goalSnapshot();
    const session = makeSession({
      getGoal: vi.fn(async () => goal),
    });
    const driver = makeDriver(makeStartupInput({}, {}, { sessions: [session] }));

    await expect(driver.init()).resolves.toBe(false);

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(driver.state.appState.goal).toEqual(goal);
  });

  it('clears goal state when closing the current session', async () => {
    const goal = goalSnapshot();
    const session = makeSession({
      getGoal: vi.fn(async () => goal),
    });
    const driver = makeDriver(makeStartupInput({}, {}, { sessions: [session] })) as unknown as StartupDriver;

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState.goal).toEqual(goal);

    await driver.closeSession('test close');

    expect(driver.state.appState.goal).toBeNull();
  });

  it('passes the CLI model override when creating a fresh startup session', async () => {
    const driver = makeDriver(makeStartupInput({ model: 'kimi-code/k2.5' }));

    await expect(driver.init()).resolves.toBe(false);
  });

  it('applies the CLI model override when resuming a startup session', async () => {
    let model = 'k2';
    const session = makeSession({
      setModel: vi.fn(async (nextModel: string) => {
        model = nextModel;
      }),
      getStatus: vi.fn(async () => ({
        model,
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const driver = makeDriver(
      makeStartupInput({ continue: true, model: 'kimi-code/k2.5' }, {}, { sessions: [session] }),
    );

    await expect(driver.init()).resolves.toBe(true);

    expect(session.setModel).toHaveBeenCalledWith('kimi-code/k2.5');
    expect(driver.state.appState.model).toBe('kimi-code/k2.5');
  });

  it('enters picker startup for bare --session without creating a session', async () => {
    const driver = makeDriver(makeStartupInput({ session: '' }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('picker');
  });

  it('applies --plan after picking a session from bare --session', async () => {
    let permission = 'manual';
    const session = makeSession({
      id: 'ses-picked',
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission,
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
      setPermission: vi.fn(async (mode: string) => {
        permission = mode;
      }),
    });
    const driver = makeDriver(makeStartupInput({ session: '', plan: true }, {}, { sessions: [session] }));

    await (driver as unknown as { initMainTui(): Promise<boolean> }).initMainTui();
    expect(driver.state.startupState).toBe('picker');
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('toggles the sessions picker from current cwd to all sessions with Ctrl+A', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    }).identity;
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
    }).identity;
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const driver = makeDriver(makeStartupInput({}, {}, { listSessions }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    expect(listSessions).toHaveBeenNthCalledWith(1, { workDir: '/tmp/proj-a' });
    expect(listSessions).toHaveBeenNthCalledWith(2, {});
    expect(driver.state.sessionsScope).toBe('all');
    expect(driver.state.sessions.map((session) => session.id)).toEqual(['ses-cwd', 'ses-other-cwd']);
  });

  it('toggles the sessions picker from all sessions back to current cwd with Ctrl+A', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    }).identity;
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
    }).identity;
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const driver = makeDriver(makeStartupInput({}, {}, { listSessions }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const firstPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    firstPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));
    const allPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    allPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    expect(listSessions).toHaveBeenNthCalledWith(3, { workDir: '/tmp/proj-a' });
    expect(driver.state.sessionsScope).toBe('cwd');
    expect(driver.state.sessions.map((session) => session.id)).toEqual(['ses-cwd']);
  });

  it('does not remount the session picker after it is closed while a scope toggle is pending', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    }).identity;
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
    }).identity;
    let resolveAllSessions: ((value: SessionIdentity[]) => void) | undefined;
    const listSessions = vi.fn((input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return Promise.resolve([currentWorkDirSession]);
      return new Promise<SessionIdentity[]>((resolve) => {
        resolveAllSessions = resolve;
      });
    });
    const driver = makeDriver(makeStartupInput({}, {}, { listSessions }));
    const mountSessionPicker = vi.spyOn(
      driver as unknown as { mountSessionPicker(options: unknown): void },
      'mountSessionPicker',
    );
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);

    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\u0001');
    (driver as unknown as { hideSessionPicker(): void }).hideSessionPicker();
    resolveAllSessions?.([currentWorkDirSession, otherWorkDirSession]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(driver.state.activeDialog).toBeNull();
    expect(mountSessionPicker).toHaveBeenCalledTimes(1);
  });

  it('clears the sessions picker search query when toggling scope with Ctrl+A', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    }).identity;
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
    }).identity;
    const listSessions = vi.fn(async (input: { workDir?: string } = {}) => {
      if (input.workDir === '/tmp/proj-a') return [currentWorkDirSession];
      return [currentWorkDirSession, otherWorkDirSession];
    });
    const driver = makeDriver(makeStartupInput({}, {}, { listSessions }));
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const firstPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    firstPicker.handleInput('c');
    firstPicker.handleInput('w');
    firstPicker.handleInput('d');
    expect(firstPicker.render(160).join('\n')).toContain('Search: cwd');

    firstPicker.handleInput('\u0001');
    await new Promise((resolve) => setImmediate(resolve));

    const allPicker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const output = allPicker.render(160).join('\n');

    expect(driver.state.sessionsScope).toBe('all');
    expect(output).toContain('All sessions');
    expect(output).toContain('(type to search)');
    expect(output).not.toContain('Search: cwd');
  });

  it('does not resume a session from a different cwd and shows a cd hint', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    });
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
    });
    const listSessions = vi.fn(async () => [currentWorkDirSession.identity, otherWorkDirSession.identity]);
    const resumeSession = vi.fn(async () => otherWorkDirSession.identity);
    const driver = makeDriver(
      makeStartupInput(
        {},
        {},
        {
          sessions: [currentWorkDirSession, otherWorkDirSession],
          listSessions,
          resumeSession,
        },
      ),
    );
    await expect(driver.init()).resolves.toBe(false);
    copyTextToClipboardMock.mockClear();

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    expect(driver.state.activeDialog).toBeNull();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj-b')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('Current session is in a different working directory.');
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
    expect(transcript).toContain('Command copied to clipboard');
  });

  it('copies a shell-safe resume command for another cwd with metacharacters', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    });
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj$(touch /tmp/pwned)',
    });
    const listSessions = vi.fn(async () => [currentWorkDirSession.identity, otherWorkDirSession.identity]);
    const resumeSession = vi.fn(async () => otherWorkDirSession.identity);
    const driver = makeDriver(
      makeStartupInput(
        {},
        {},
        {
          sessions: [currentWorkDirSession, otherWorkDirSession],
          listSessions,
          resumeSession,
        },
      ),
    );
    await expect(driver.init()).resolves.toBe(false);
    copyTextToClipboardMock.mockClear();

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj$(touch /tmp/pwned)')} && kimi --resume ${quoteShellArg(
      'ses-other-cwd',
    )}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    const transcript = driver.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain(`To resume, run: ${expectedResumeCmd}`);
  });

  it('exits after picking another cwd from the startup picker', async () => {
    const currentWorkDirSession = makeSession({
      id: 'ses-cwd',
      title: 'Current cwd session',
    });
    const otherWorkDirSession = makeSession({
      id: 'ses-other-cwd',
      title: 'Other cwd session',
      workDir: '/tmp/proj-b',
    });
    const listSessions = vi.fn(async () => [currentWorkDirSession.identity, otherWorkDirSession.identity]);
    const resumeSession = vi.fn(async () => otherWorkDirSession.identity);
    const driver = makeDriver(
      makeStartupInput(
        { session: '' },
        {},
        {
          sessions: [currentWorkDirSession, otherWorkDirSession],
          listSessions,
          resumeSession,
        },
      ),
    );
    const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);
    copyTextToClipboardMock.mockClear();

    await expect((driver as unknown as MigrateExitDriver).initMainTui()).resolves.toBe(false);
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumeSession).not.toHaveBeenCalled();
    const expectedResumeCmd = `cd ${quoteShellArg('/tmp/proj-b')} && kimi --resume ${quoteShellArg('ses-other-cwd')}`;
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(expectedResumeCmd);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(0);
  });

  it('does not apply startup flags when switching sessions via the /sessions picker', async () => {
    const initial = makeSession({ id: 'ses-1' });
    const picked = makeSession({
      id: 'ses-2',
      setPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const listSessions = vi.fn(async () => [picked.identity]);
    const driver = makeDriver(
      makeStartupInput({ auto: true, plan: true }, {}, { sessions: [initial, picked], listSessions }),
    );
    await expect(driver.init()).resolves.toBe(false);

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(driver.state.appState.sessionId).toBe('ses-2');
    expect(picked.setPermission).not.toHaveBeenCalled();
    expect(picked.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.permissionMode).toBe('manual');
    expect(driver.state.appState.planMode).toBe(false);
  });

  it('clears startup picker exit confirmation before resuming a selected session', async () => {
    const session = makeSession({ id: 'ses-picked' });
    const driver = makeDriver(makeStartupInput({ session: '' }, {}, { sessions: [session] }));
    const stop = vi.spyOn(driver, 'stop').mockResolvedValue(undefined);

    await expect((driver as unknown as MigrateExitDriver).initMainTui()).resolves.toBe(false);
    await (driver as unknown as { bootstrapFromPicker(): Promise<void> }).bootstrapFromPicker();

    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput('\u0003');
    picker.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));

    driver.state.editor.onCtrlC?.();

    expect(stop).not.toHaveBeenCalled();
  });

  it('tracks terminal theme reports while auto theme is active', () => {
    const driver = makeDriver(makeStartupInput({}, { theme: 'auto' })) as unknown as ThemeTrackingDriver;
    const { listeners, write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(ENABLE_TERMINAL_THEME_REPORTING);
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(write).toHaveBeenCalledWith(QUERY_TERMINAL_THEME);
    expect(listeners).toHaveLength(1);

    write.mockClear();
    expect(listeners[0]?.(TERMINAL_THEME_LIGHT)).toEqual({ consume: true });
    expect(write).toHaveBeenCalledWith(OSC11_QUERY);
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(DARK_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    expect(listeners[0]?.(LIGHT_OSC11_REPORT)).toEqual({ consume: true });
    expect(driver.state.appState.theme).toBe('auto');
    expect(driver.state.ui.requestRender).toHaveBeenCalled();
  });

  it('does not track terminal theme reports for explicit themes', () => {
    const driver = makeDriver(makeStartupInput()) as unknown as ThemeTrackingDriver;
    const { write, addInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();

    expect(addInputListener).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('disables terminal theme reports after leaving auto theme', () => {
    const driver = makeDriver(makeStartupInput({}, { theme: 'auto' })) as unknown as ThemeTrackingDriver;
    const { write, removeInputListener } = captureInputListeners(driver);

    driver.refreshTerminalThemeTracking();
    driver.state.appState.theme = 'dark';
    driver.refreshTerminalThemeTracking();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(DISABLE_TERMINAL_THEME_REPORTING);
  });

  it('only shows provider refresh status for added models', async () => {
    const driver = makeDriver(makeStartupInput());
    const showStatus = vi.spyOn(driver as any, 'showStatus').mockImplementation(() => {});
    vi.spyOn((driver as any).authFlow, 'refreshProviderModels').mockResolvedValue({
      changed: [
        {
          providerId: 'new-models',
          providerName: 'New Models',
          added: 2,
          removed: 0,
        },
        {
          providerId: 'removed-models',
          providerName: 'Removed Models',
          added: 0,
          removed: 3,
        },
        {
          providerId: 'metadata-only',
          providerName: 'Metadata Only',
          added: 0,
          removed: 0,
        },
      ],
      unchanged: [],
      failed: [],
    });

    await (driver as any).refreshProviderModelsInBackground();

    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledWith('New Models · +2 models.');
  });

  it('starts TUI without a session when fresh startup needs OAuth login', async () => {
    const createSession = vi.fn<SessionControlPort['sessions']['create']>().mockRejectedValue(loginRequiredError());
    const driver = makeDriver(makeStartupInput({}, {}, { createSession }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect((driver as any).startupNotice).toContain('OAuth login expired');
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
  });

  it('preserves fresh startup yolo and plan intent after OAuth login', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'yolo',
        planMode: true,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn<SessionControlPort['sessions']['create']>()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session.identity);
    const driver = makeDriver(
      makeStartupInput(
        { yolo: true, plan: true },
        {},
        { sessions: [session], createSession, models: makeManagedModels() },
      ),
    );

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      permissionMode: 'yolo',
      planMode: true,
    });

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(1, {
      workDir: '/tmp/proj-a',
      permission: 'yolo',
      planMode: true,
    });
    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: undefined,
      permission: 'yolo',
      planMode: true,
      additionalDirs: undefined,
    });
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
      permissionMode: 'yolo',
      planMode: true,
    });
  });

  it('does not force manual permission after OAuth login without --yolo', async () => {
    const session = makeSession({
      getStatus: vi.fn(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'auto',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 100,
        contextUsage: 0.1,
      })),
    });
    const createSession = vi
      .fn<SessionControlPort['sessions']['create']>()
      .mockRejectedValueOnce(loginRequiredError())
      .mockResolvedValueOnce(session.identity);
    const driver = makeDriver(
      makeStartupInput({}, {}, { sessions: [session], createSession, models: makeManagedModels() }),
    );

    await expect(driver.init()).resolves.toBe(false);
    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(createSession).toHaveBeenNthCalledWith(2, {
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: undefined,
      permission: undefined,
      planMode: undefined,
      additionalDirs: undefined,
    });
    expect(driver.state.appState).toMatchObject({
      permissionMode: 'auto',
    });
  });

  it('does not override active session thinking when configured thinking is enabled after OAuth login', async () => {
    const session = makeSession();
    const models = {
      load: vi.fn(async () => ({
        defaultModel: 'k2',
        thinking: { enabled: true },
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'moonshot-v1',
            maxContextSize: 100,
          },
        },
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            status: 'connected' as const,
            hasApiKey: true,
          },
        },
      })),
    } satisfies RuntimeModelCatalogPort;
    const { runtime, telemetry, sessionRuntime } = makeTUIRuntime({ models });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    await expect(driver.init()).resolves.toBe(false);
    expect(driver.state.appState.thinkingEffort).toBe('off');

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);

    expect(sessionRuntime.agent.setModel).toHaveBeenCalledWith('k2');
    // `thinking.enabled === true` means "leave the session's current thinking
    // level alone" — only an explicit `enabled === false` forces `'off'`.
    expect(sessionRuntime.agent.setThinking).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      model: 'k2',
      thinkingEffort: 'off',
      maxContextTokens: 100,
    });
    expect(models.load).toHaveBeenCalledTimes(2);
    expect(models.load).toHaveBeenNthCalledWith(2, { reload: true });
    expect(telemetry.track).toHaveBeenCalledWith('login', {
      provider: 'managed:kimi-code',
      method: 'oauth',
      already_logged_in: false,
    });
  });

  it('tracks login with already_logged_in when a token already exists', async () => {
    const session = makeSession();
    const driver = makeDriver(makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
    await handleLoginCommand(driver as any);
  });

  it('logs login failures with session context', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const session = makeSession();
    const loginError = new Error('Failed to list Kimi Code models (HTTP 402).');
    const driver = makeDriver(
      makeStartupInput(
        {},
        {},
        {
          sessions: [session],
          auth: {
            login: vi.fn(async () => {
              throw loginError;
            }),
          },
        },
      ),
    );

    try {
      await expect(driver.init()).resolves.toBe(false);

      vi.mocked(promptPlatformSelection).mockResolvedValue('kimi-code');
      await handleLoginCommand(driver as any);

      expect(warn).toHaveBeenCalledWith(
        'login failed',
        expect.objectContaining({
          providerName: 'managed:kimi-code',
          alreadyLoggedIn: false,
          sessionId: 'ses-1',
          error: expect.objectContaining({
            message: 'Failed to list Kimi Code models (HTTP 402).',
          }),
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('tracks logout after managed credentials and session state are cleared', async () => {
    const session = makeSession();
    const configuredCatalog = {
      models: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'moonshot-v1',
          maxContextSize: 100,
        },
      },
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          status: 'connected' as const,
          hasApiKey: true,
        },
      },
    };
    const models = {
      load: vi
        .fn()
        .mockResolvedValueOnce(configuredCatalog)
        .mockResolvedValueOnce(configuredCatalog)
        .mockResolvedValueOnce({ models: {}, providers: {} }),
    } satisfies RuntimeModelCatalogPort;
    const { runtime, telemetry, sessionRuntime } = makeTUIRuntime({ models });
    const driver = makeDriver({
      ...makeStartupInput(),
      runtime,
    });

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);

    expect(runtime.auth.logout).toHaveBeenCalledWith('managed:kimi-code');
    expect(sessionRuntime.lifecycle.close).toHaveBeenCalledOnce();
    expect(driver.state.appState).toMatchObject({
      sessionId: '',
      model: '',
      sessionTitle: null,
      availableModels: {},
      availableProviders: {},
    });
    expect(models.load).toHaveBeenCalledTimes(3);
    expect(models.load).toHaveBeenNthCalledWith(3, { reload: true });
    expect(telemetry.track).toHaveBeenCalledWith('logout', {
      provider: 'managed:kimi-code',
    });
  });

  it('keeps the active session when logging out a different provider', async () => {
    const session = makeSession();
    const removeProvider = vi.fn(async () => {});
    const models = {
      load: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'moonshot-v1',
            maxContextSize: 100,
          },
        },
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            status: 'connected' as const,
            hasApiKey: true,
          },
          openai: {
            type: 'openai',
            status: 'connected' as const,
            hasApiKey: true,
          },
        },
      })),
    } satisfies RuntimeModelCatalogPort;
    const driver = makeDriver(
      makeStartupInput(
        {},
        {},
        {
          sessions: [session],
          models,
          modelConfig: {
            apply: vi.fn(async () => {}),
            removeProvider,
          },
        },
      ),
    );

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('openai');
    await handleLogoutCommand(driver as any);

    expect(removeProvider).toHaveBeenCalledWith('openai');
    expect(session.close).not.toHaveBeenCalled();
    expect(driver.state.appState).toMatchObject({
      sessionId: 'ses-1',
      model: 'k2',
    });
  });

  it('can log out a stale managed entry even after the OAuth token is gone', async () => {
    const session = makeSession();
    const driver = makeDriver(makeStartupInput());

    await expect(driver.init()).resolves.toBe(false);

    vi.mocked(promptLogoutProviderSelection).mockResolvedValue('managed:kimi-code');
    await handleLogoutCommand(driver as any);
  });

  it('starts TUI without replaying when --continue needs OAuth login', async () => {
    const session = makeSession({ id: 'ses-latest' });
    const resumeSession = vi.fn<SessionControlPort['sessions']['resume']>().mockRejectedValue(loginRequiredError());
    const driver = makeDriver(makeStartupInput({ continue: true }, {}, { sessions: [session], resumeSession }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('starts TUI without replaying when an explicit resume needs OAuth login', async () => {
    const session = makeSession({ id: 'ses-target' });
    const resumeSession = vi.fn<SessionControlPort['sessions']['resume']>().mockRejectedValue(loginRequiredError());
    const driver = makeDriver(makeStartupInput({ session: 'ses-target' }, {}, { sessions: [session], resumeSession }));

    await expect(driver.init()).resolves.toBe(false);

    expect(driver.state.startupState).toBe('ready');
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('disposes terminal focus/theme tracking on the kimi migrate exit', async () => {
    const driver = makeDriver({
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: true,
    }) as unknown as MigrateExitDriver;
    // pi-tui start/stop and focus tracking touch the real TTY — stub the I/O.
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    // The migration screen would await user input; resolve it immediately.
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({
      decision: 'later',
    });
    const onExit = vi.fn(async () => {});
    driver.onExit = onExit;

    await driver.start();

    // `kimi migrate` exits via process.exit; startEventLoop() installed focus
    // tracking, so the exit path must dispose it — otherwise the terminal
    // keeps emitting focus/OSC sequences after the command finishes.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('disposes terminal tracking when post-migration startup fails', async () => {
    const driver = makeDriver({
      ...makeStartupInput(),
      migrationPlan: MIGRATION_PLAN,
      migrateOnly: false,
    }) as unknown as MigrateExitDriver;
    vi.spyOn(driver.state.ui, 'start').mockImplementation(() => {});
    vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {});
    vi.spyOn(driver.state.terminal, 'write').mockImplementation(() => {});
    // The migration screen resolves "later"; startup then continues into
    // initMainTui(), which fails (e.g. a session-resume error).
    vi.spyOn(driver, 'runMigrationScreen').mockResolvedValue({
      decision: 'later',
    });
    vi.spyOn(driver, 'initMainTui').mockRejectedValue(new Error('resume boom'));

    await expect(driver.start()).rejects.toThrow('resume boom');

    // The focus tracking installed by startEventLoop() must be torn down
    // before the error propagates — not left active after the process exits.
    expect(driver.terminalFocusTrackingDispose).toBeUndefined();
  });

  it('keeps non-login startup session errors fatal', async () => {
    const createSession = vi
      .fn<SessionControlPort['sessions']['create']>()
      .mockRejectedValue(new Error('provider config is invalid'));
    const driver = makeDriver(makeStartupInput({}, {}, { createSession }));

    await expect(driver.init()).rejects.toThrow('provider config is invalid');
  });

  it('does not mount the footer when resuming a missing session fails', async () => {
    // Regression: a stray pre-startEventLoop render used to paint the footer
    // (cwd/git + "context:" statusline) to the terminal before the fatal
    // error, leaving it stranded above the error message. The footer must not
    // be in the layout tree when initMainTui() throws.
    const driver = makeDriver(makeStartupInput({ session: 'missing-session' })) as unknown as MigrateExitDriver;
    await expect(driver.initMainTui()).rejects.toThrow('Session "missing-session" not found.');
    expect(uiContainsFooter(driver)).toBe(false);
  });

  it('mounts the footer once startup reaches the main TUI', async () => {
    const session = makeSession({ id: 'ses-target' });
    const driver = makeDriver(
      makeStartupInput({ session: 'ses-target' }, {}, { sessions: [session] }),
    ) as unknown as MigrateExitDriver;
    // Not mounted until init() succeeds.
    expect(uiContainsFooter(driver)).toBe(false);

    await driver.initMainTui();

    expect(uiContainsFooter(driver)).toBe(true);
  });

  it('renders the banner below the welcome message after it loads', async () => {
    const banner = {
      key: 'new-banner',
      tag: 'New',
      mainText: 'Banner main',
      subText: null,
      display: 'always' as const,
    };
    const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
    const session = makeSession({ id: 'ses-target' });
    const driver = makeDriver(
      makeStartupInput({ session: 'ses-target' }, {}, { sessions: [session] }),
    ) as unknown as MigrateExitDriver;
    await driver.initMainTui();

    await vi.waitFor(() => {
      expect(driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)).toBe(true);
    });

    // The banner is rendered directly below the welcome panel so it appears
    // above later status messages such as MCP server connection summaries.
    const welcomeIndex = driver.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const bannerIndex = driver.state.transcriptContainer.children.findIndex(
      (child) => child instanceof BannerComponent,
    );
    expect(welcomeIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBe(welcomeIndex + 1);

    loadSpy.mockRestore();
  });

  it('writes display state after rendering a once banner', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'kimi-startup-banner-'));
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      const banner = {
        key: 'once-banner',
        tag: null,
        mainText: 'Banner main',
        subText: null,
        display: 'once' as const,
      };
      const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
      const session = makeSession({ id: 'ses-target' });
      const driver = makeDriver(
        makeStartupInput({ session: 'ses-target' }, {}, { sessions: [session] }),
      ) as unknown as MigrateExitDriver;
      await driver.initMainTui();

      await vi.waitFor(() => {
        expect(driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)).toBe(true);
      });

      // writeBannerDisplayState runs after renderBanner; on Windows the atomic
      // write can lag behind the render, so wait for the state to land before
      // asserting it.
      await vi.waitFor(
        async () => {
          const state = await readBannerDisplayState();
          expect(state.shown['once-banner']?.lastShownAt).toBeDefined();
        },
        { timeout: 5000 },
      );
      await expect(readBannerDisplayState()).resolves.toMatchObject({
        version: 1,
        shown: {
          'once-banner': {
            lastShownAt: expect.any(String),
          },
        },
      });

      loadSpy.mockRestore();
    } finally {
      process.env = { ...originalEnv };
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write display state for an always banner', async () => {
    const originalEnv = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'kimi-startup-banner-'));
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      const banner = {
        key: 'always-banner',
        tag: null,
        mainText: 'Banner main',
        subText: null,
        display: 'always' as const,
      };
      const loadSpy = vi.spyOn(BannerProvider.prototype, 'load').mockResolvedValue(banner);
      const session = makeSession({ id: 'ses-target' });
      const driver = makeDriver(
        makeStartupInput({ session: 'ses-target' }, {}, { sessions: [session] }),
      ) as unknown as MigrateExitDriver;
      await driver.initMainTui();

      await vi.waitFor(() => {
        expect(driver.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)).toBe(true);
      });

      await expect(readBannerDisplayState()).resolves.toEqual({
        version: 1,
        shown: {},
      });

      loadSpy.mockRestore();
    } finally {
      process.env = { ...originalEnv };
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes a startup session when Windows workdir uses backslashes', async () => {
    const workDir = String.raw`C:\Users\kimi\project`;
    const session = makeSession({ id: 'ses-target', workDir });
    const driver = makeDriver({
      ...makeStartupInput({ session: 'ses-target' }, {}, { sessions: [session] }),
      workDir,
    });

    await expect(driver.init()).resolves.toBe(true);

    expect(driver.state.appState.sessionId).toBe('ses-target');
  });
});

function uiContainsFooter(driver: StartupDriver): boolean {
  const target: unknown = driver.state.footer;
  const visit = (node: unknown): boolean => {
    if (node === target) return true;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) && children.some(visit);
  };
  return visit(driver.state.ui);
}
