import {
  agentCatalogRuntimeOptionsSeed,
  applyPrintModeConfigDefaults,
  bootstrap,
  createCloudAppender,
  hostRequestHeadersSeed,
  IBootstrapService,
  IConfigService,
  IHostFileSystem,
  ILogService,
  ISessionExportService,
  ISessionContext,
  ISessionLifecycleService,
  ITelemetryService,
  logSeed,
  parseAgentFileText,
  persistOriginalImage,
  resolveAgentPath,
  resolveLoggingConfig,
  sessionMediaOriginalsDir,
  skillCatalogRuntimeOptionsSeed,
  type TelemetryContextPatch,
  type ExportSessionPayload,
  type ExportSessionResult,
  type LogLevel,
  type LogPayload,
} from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';
import type {
  CreateSessionOptions as HostedCreateSessionOptions,
  ResumeSessionOptions as HostedResumeSessionOptions,
  SessionHostContext,
} from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';

export interface KimiV2RuntimeOptions {
  readonly homeDir: string;
  readonly configPath?: string;
  readonly clientVersion?: string;
  /** Host-owned provider request headers, such as product and device identity. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
  /** Explicit skill roots for this process. Empty keeps normal discovery. */
  readonly skillDirs?: readonly string[];
  /** Explicit agent definition files for this process. */
  readonly agentFiles?: readonly string[];
  /** Apply headless-agent defaults without persisting them to config.toml. */
  readonly mode?: 'default' | 'print';
  /** Optional Cloud Telemetry sink owned and shut down by this runtime. */
  readonly telemetry?: KimiV2TelemetryOptions;
}

export interface KimiV2TelemetryOptions {
  readonly enabled: boolean;
  readonly deviceId: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
}

export interface KimiV2TelemetryContext {
  readonly sessionId?: string | null;
  readonly model?: string | null;
}

/** Narrow host telemetry surface; the engine service and appender stay private. */
export interface KimiV2Telemetry {
  setContext(context: KimiV2TelemetryContext): void;
  track(event: 'first_launch'): void;
  track(event: 'exit', properties: { readonly duration_ms: number }): void;
  track(
    event: string,
    properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void;
  shutdown(): Promise<void>;
}

export interface KimiV2AgentFiles {
  /**
   * Resolve and validate one explicit agent file using the same parser and
   * path rules as the session catalog, returning the profile it contributes.
   */
  resolveProfileName(input: {
    readonly file: string;
    readonly workDir: string;
  }): Promise<string>;
}

export interface KimiV2LocalMedia {
  /**
   * Persist pre-compression image bytes through the runtime-owned host
   * filesystem. A live session id places the file in that session's
   * media-originals directory; otherwise the shared cache is used.
   */
  persistOriginalImage(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly sessionId?: string;
  }): Promise<string | null>;
}

export interface KimiV2HostedSession {
  readonly id: string;
}

/**
 * In-process lifecycle seam for hosts that supply non-serializable session
 * resources such as an editor-backed workspace filesystem.
 *
 * These overrides deliberately bypass Klient's wire contract and are never
 * accepted by the serializable global.sessions facade.
 */
export interface KimiV2HostedSessions {
  create(
    input: HostedCreateSessionOptions,
    host?: SessionHostContext,
  ): Promise<KimiV2HostedSession>;
  resume(
    sessionId: string,
    input?: HostedResumeSessionOptions,
    host?: SessionHostContext,
  ): Promise<KimiV2HostedSession | undefined>;
}

export interface KimiV2Diagnostics {
  readonly globalLogPath: string;
  write(
    level: Exclude<LogLevel, 'off'>,
    message: string,
    payload?: LogPayload,
  ): boolean;
  flush(): Promise<void>;
}

export interface KimiV2HostedSessionExport {
  export(
    input: ExportSessionPayload,
    options?: { readonly globalLogPath?: string },
  ): Promise<ExportSessionResult>;
}

/**
 * Minimal v2 host composition root.
 *
 * The runtime owns process-local engine resources while callers only see the
 * contract-driven Klient control plane. Scope and service-locator details stay
 * private so hosts can later swap the in-memory transport without changing
 * their product code.
 */
export interface KimiV2Runtime {
  readonly klient: Klient;
  readonly telemetry: KimiV2Telemetry;
  readonly agentFiles: KimiV2AgentFiles;
  readonly localMedia: KimiV2LocalMedia;
  readonly hostedSessions: KimiV2HostedSessions;
  readonly diagnostics: KimiV2Diagnostics;
  readonly hostedSessionExport: KimiV2HostedSessionExport;
  close(): Promise<void>;
}

export type KimiV2PrintBackgroundMode = 'exit' | 'drain' | 'steer';

export interface KimiV2PrintBackgroundSettings {
  readonly mode: KimiV2PrintBackgroundMode;
  readonly ceilingS: number;
  readonly maxTurns: number;
}

const PRINT_BACKGROUND_TASK_POLL_MS = 100;
const DEFAULT_PRINT_WAIT_CEILING_S = 315_360_000;
const DEFAULT_PRINT_MAX_TURNS = 100_000;

export async function resolveKimiV2PrintBackgroundSettings(
  runtime: KimiV2Runtime,
): Promise<KimiV2PrintBackgroundSettings> {
  const current = await runtime.klient.global.config.get<{
    readonly keepAliveOnExit?: boolean;
    readonly printBackgroundMode?: KimiV2PrintBackgroundMode;
    readonly printWaitCeilingS?: number;
    readonly printMaxTurns?: number;
  } | undefined>('task');
  const legacy = await runtime.klient.global.config.get<typeof current>('background');
  const config = { ...legacy, ...current };
  return {
    mode:
      config.printBackgroundMode ??
      (config.keepAliveOnExit === true ? 'drain' : 'steer'),
    ceilingS: config.printWaitCeilingS ?? DEFAULT_PRINT_WAIT_CEILING_S,
    maxTurns: config.printMaxTurns ?? DEFAULT_PRINT_MAX_TURNS,
  };
}

export async function countKimiV2ActiveTasks(
  runtime: KimiV2Runtime,
  sessionId: string,
): Promise<number> {
  const session = runtime.klient.session(sessionId);
  const agents = await session.agents();
  const agentIds = new Set(['main', ...Object.keys(agents)]);
  let total = 0;
  for (const agentId of agentIds) {
    try {
      total += (await session.agent(agentId).getTasks({ activeOnly: true })).length;
    } catch {}
  }
  return total;
}

export async function drainKimiV2BackgroundTasks(
  runtime: KimiV2Runtime,
  sessionId: string,
  ceilingS: number,
): Promise<void> {
  const deadline = Date.now() + ceilingS * 1000;
  while (Date.now() < deadline) {
    if ((await countKimiV2ActiveTasks(runtime, sessionId)) === 0) {
      if ((await runtime.klient.session(sessionId).status()) !== 'running') return;
    }
    await delay(PRINT_BACKGROUND_TASK_POLL_MS);
  }
}

export async function waitForKimiV2PrintBackgroundTasks(
  runtime: KimiV2Runtime,
  sessionId: string,
): Promise<void> {
  const settings = await resolveKimiV2PrintBackgroundSettings(runtime);
  if (settings.mode !== 'drain') return;
  await drainKimiV2BackgroundTasks(runtime, sessionId, settings.ceilingS);
}

export async function handleKimiV2CompletedPrintTurn(
  runtime: KimiV2Runtime,
  sessionId: string,
): Promise<'finish' | 'continue'> {
  const settings = await resolveKimiV2PrintBackgroundSettings(runtime);
  if (settings.mode === 'exit') return 'finish';
  if (settings.mode === 'drain') {
    await drainKimiV2BackgroundTasks(runtime, sessionId, settings.ceilingS);
    return 'finish';
  }
  return (await countKimiV2ActiveTasks(runtime, sessionId)) > 0
    ? 'continue'
    : 'finish';
}

export async function createKimiV2Runtime(
  options: KimiV2RuntimeOptions,
): Promise<KimiV2Runtime> {
  const logging = resolveLoggingConfig({ homeDir: options.homeDir, env: process.env });
  const { app } = bootstrap(
    {
      homeDir: options.homeDir,
      configPath: options.configPath,
      clientVersion: options.clientVersion,
    },
    [
      ...logSeed(logging),
      ...hostRequestHeadersSeed(options.requestHeaders ?? {}),
      ...skillCatalogRuntimeOptionsSeed(options.skillDirs),
      ...agentCatalogRuntimeOptionsSeed(options.agentFiles),
    ],
  );

  const config = app.accessor.get(IConfigService);
  try {
    await config.ready;
    if (options.mode === 'print') {
      await applyPrintModeConfigDefaults(config);
    }
  } catch (error) {
    app.dispose();
    throw error;
  }

  const telemetryService = app.accessor.get(ITelemetryService);
  const telemetryEnabled =
    options.telemetry?.enabled === true && readTelemetryEnabled(config);
  telemetryService.setEnabled(telemetryEnabled);
  if (telemetryEnabled && options.telemetry !== undefined) {
    telemetryService.setAppender(
      createCloudAppender(app.accessor, {
        deviceId: options.telemetry.deviceId,
        appName: options.telemetry.appName,
        uiMode: options.telemetry.uiMode,
        model:
          options.telemetry.model ??
          config.get<string | undefined>('defaultModel') ??
          undefined,
        getAccessToken: options.telemetry.getAccessToken,
      }),
    );
  }

  let telemetryShutdown: Promise<void> | undefined;
  const telemetry: KimiV2Telemetry = {
    setContext(context): void {
      telemetryService.setContext(context as TelemetryContextPatch);
    },
    track(
      event: string,
      properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
    ): void {
      telemetryService.track(event, properties);
    },
    shutdown(): Promise<void> {
      return (telemetryShutdown ??= telemetryService.shutdown());
    },
  };

  const bootstrapService = app.accessor.get(IBootstrapService);
  const hostFs = app.accessor.get(IHostFileSystem);
  const sessions = app.accessor.get(ISessionLifecycleService);
  const agentFiles: KimiV2AgentFiles = {
    async resolveProfileName(input): Promise<string> {
      const path = resolveAgentPath(
        input.file,
        input.workDir,
        bootstrapService.osHomeDir,
      );
      let text: string;
      try {
        text = await hostFs.readText(path);
      } catch (error) {
        throw new Error(
          `Failed to read agent file "${path}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      try {
        return parseAgentFileText({ path, source: 'explicit', text }).name;
      } catch (error) {
        throw new Error(
          `Invalid agent file "${path}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    },
  };
  const localMedia: KimiV2LocalMedia = {
    async persistOriginalImage(input): Promise<string | null> {
      const session =
        input.sessionId === undefined || input.sessionId.length === 0
          ? undefined
          : sessions.get(input.sessionId);
      const dir =
        session === undefined
          ? undefined
          : sessionMediaOriginalsDir(
              session.accessor.get(ISessionContext).sessionDir,
            );
      return persistOriginalImage(input.bytes, input.mimeType, {
        dir,
        hostFs,
      });
    },
  };
  const hostedSessions: KimiV2HostedSessions = {
    async create(input, host): Promise<KimiV2HostedSession> {
      const session = await sessions.create(input, host);
      return { id: session.id };
    },
    async resume(sessionId, input, host): Promise<KimiV2HostedSession | undefined> {
      const session = await sessions.resume(sessionId, input, host);
      return session === undefined ? undefined : { id: session.id };
    },
  };
  const appLog = app.accessor.get(ILogService);
  const diagnostics: KimiV2Diagnostics = {
    globalLogPath: logging.globalLogPath,
    write(level, message, payload): boolean {
      const sessionId = logSessionId(payload);
      if (sessionId === undefined) {
        appLog[level](message, payload);
        return true;
      }
      const session = sessions.get(sessionId);
      if (session === undefined) return false;
      session.accessor.get(ILogService)[level](message, payload);
      return true;
    },
    async flush(): Promise<void> {
      await Promise.all([
        appLog.flush(),
        ...sessions.list().map((session) => session.accessor.get(ILogService).flush()),
      ]);
    },
  };
  const sessionExport = app.accessor.get(ISessionExportService);
  const hostedSessionExport: KimiV2HostedSessionExport = {
    export(input, options): Promise<ExportSessionResult> {
      return sessionExport.export(input, {
        globalLogPath: options?.globalLogPath,
      });
    },
  };

  const klient = createKlient({ scope: app });
  let closed = false;
  return {
    klient,
    telemetry,
    agentFiles,
    localMedia,
    hostedSessions,
    diagnostics,
    hostedSessionExport,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        for (const session of sessions.list()) {
          await sessions.close(session.id);
        }
      } finally {
        try {
          await telemetry.shutdown();
        } finally {
          try {
            await klient.close();
          } finally {
            app.dispose();
          }
        }
      }
    },
  };
}

function logSessionId(payload: LogPayload): string | undefined {
  if (payload === null || typeof payload !== 'object' || payload instanceof Error) {
    return undefined;
  }
  const sessionId = (payload as Readonly<Record<string, unknown>>)['sessionId'];
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function readTelemetryEnabled(config: IConfigService): boolean {
  try {
    return config.get('telemetry') !== false;
  } catch {
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
