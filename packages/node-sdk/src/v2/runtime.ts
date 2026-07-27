import {
  agentCatalogRuntimeOptionsSeed,
  applyPrintModeConfigDefaults,
  bootstrap,
  createCloudAppender,
  hostRequestHeadersSeed,
  IBootstrapService,
  IConfigService,
  IHostFileSystem,
  ISessionLifecycleService,
  ITelemetryService,
  logSeed,
  parseAgentFileText,
  resolveAgentPath,
  resolveLoggingConfig,
  skillCatalogRuntimeOptionsSeed,
  type TelemetryContextPatch,
} from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';

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
  close(): Promise<void>;
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

  const klient = createKlient({ scope: app });
  let closed = false;
  return {
    klient,
    telemetry,
    agentFiles,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        const sessions = app.accessor.get(ISessionLifecycleService);
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

function readTelemetryEnabled(config: IConfigService): boolean {
  try {
    return config.get('telemetry') !== false;
  } catch {
    return true;
  }
}
