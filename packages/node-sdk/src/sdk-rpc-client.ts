import { createRPC, type RPCMethods } from '#/sdk-rpc';
import { ensureConfigFile } from '#/sdk-config';
import { resolveConfigPath, resolveKimiHome } from '#/sdk-paths';
import { noopTelemetryClient, type TelemetryClient } from '#/sdk-telemetry';
import type { Kaos } from '@moonshot-ai/kaos';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import { ClientAPI, SDKRpcClientBase, type ResolvedCoreAPI } from '#/rpc';
import type {
  CreateSessionOptions,
  KimiHarnessOptions,
  KimiHostIdentity,
  OAuthRefreshOutcome,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
} from '#/types';
import type { OAuthRef } from '#/sdk-config';

// ── Local type shims for legacy agent-core protocol types ────────────────

interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

interface RootLoggerStub {
  configure(config: Record<string, unknown>): void;
  flush(): Promise<void>;
}

const ROOT_LOGGER_STUB: RootLoggerStub = {
  configure(_config: Record<string, unknown>): void {},
  async flush(): Promise<void> {},
};

function getRootLogger(): RootLoggerStub {
  return ROOT_LOGGER_STUB;
}

function resolveLoggingConfig(_options: { readonly homeDir: string }): Record<string, unknown> {
  return {};
}

interface ImageLimitsShim {
  readonly maxEdgePx: number;
  readonly readByteBudget: number;
}

/**
 * Minimal surface of the legacy KimiCore class, defined as an interface so
 * the in-process SDK client can work without a static import of
 * @moonshot-ai/agent-core.  The actual KimiCore is loaded at runtime via
 * a dynamic import with a constructed specifier.
 */
interface CoreShim {
  readonly imageLimits: ImageLimitsShim;
  createSessionWithOverrides(
    input: Record<string, unknown>,
    overrides: { readonly kaos?: Kaos; readonly persistenceKaos?: Kaos },
  ): unknown;
  resumeSessionWithOverrides(
    input: Record<string, unknown>,
    overrides: { readonly kaos?: Kaos; readonly persistenceKaos?: Kaos },
  ): unknown;
}

/**
 * v2-backed CoreShim that replaces the legacy KimiCore.
 *
 * Provides the minimal surface (createSessionWithOverrides,
 * resumeSessionWithOverrides, imageLimits) by creating a v2 runtime + Klient.
 */
async function createCore(
  _rpcClient: unknown,
  options: Record<string, unknown>,
): Promise<{ runtime: { close(): Promise<void> }; core: CoreShim }> {
  const { createKimiV2Runtime } = await import('@moonshot-ai/kimi-code-sdk/v2');
  type RuntimeOptions = Parameters<typeof createKimiV2Runtime>[0];
  const runtime = await createKimiV2Runtime({
    homeDir: options['homeDir'] as string,
    configPath: options['configPath'] as RuntimeOptions['configPath'],
    telemetry: options['telemetry'] as RuntimeOptions['telemetry'],
  });

  // Capture the Klient reference from the runtime.
  const klient = (runtime as unknown as { readonly klient: Record<string, unknown> }).klient;
  let closed = false;

  const core: CoreShim = {
    get imageLimits(): ImageLimitsShim {
      return { maxEdgePx: 8192, readByteBudget: 20_000_000 };
    },

    createSessionWithOverrides(
      input: Record<string, unknown>,
      _overrides: { readonly kaos?: Kaos; readonly persistenceKaos?: Kaos },
    ): unknown {
      if (closed) throw new Error('Runtime closed');
      const sessions = (klient as Record<string, unknown>)['global'] as Record<string, unknown>;
      const create = sessions?.['sessions'] as Record<string, unknown> | undefined;
      if (create?.['create'] === undefined) {
        throw new Error('Klient sessions.create not available');
      }
      return (create['create'] as Function)({
        workDir: (input['workDir'] as string) ?? process.cwd(),
        model: input['model'] as string | undefined,
        permission: (input['permission'] as string) ?? 'auto',
        additionalDirs: input['additionalDirs'] as readonly string[] | undefined,
      });
    },

    async resumeSessionWithOverrides(
      input: Record<string, unknown>,
      _overrides: { readonly kaos?: Kaos; readonly persistenceKaos?: Kaos },
    ): Promise<unknown> {
      if (closed) throw new Error('Runtime closed');
      const sessionId = input['id'] ?? input['sessionId'];
      const sessions = (klient as Record<string, unknown>)['global'] as Record<string, unknown>;
      const resume = sessions?.['sessions'] as Record<string, unknown> | undefined;
      if (resume?.['resume'] === undefined) {
        return { id: sessionId };
      }
      return (resume['resume'] as Function)({ sessionId, additionalDirs: input['additionalDirs'] as readonly string[] | undefined });
    },
  };

  return { runtime, core };
}

export interface SDKRpcClientOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  /**
   * Host UI mode (`'print'` for `kimi -p`, `'cli'` for the TUI, ...). Forwarded
   * to the v1 core, which applies print-mode config defaults when it is
   * `'print'`.
   */
  readonly uiMode?: string;
}

export class SDKRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  core!: CoreShim;

  // v2 runtime reference for proper cleanup on close.
  private _v2Runtime: { close(): Promise<void> } | undefined;

  private readonly ready: Promise<ResolvedCoreAPI>;

  constructor(options: SDKRpcClientOptions = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [coreRpc, sdkRpc] = createRPC<any, any>();
    this.ready = this.bootCore(coreRpc, sdkRpc, options);
  }

  private async bootCore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coreRpc: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkRpc: any,
    options: SDKRpcClientOptions,
  ): Promise<ResolvedCoreAPI> {
    const { runtime, core } = await createCore(coreRpc, {
      homeDir: options.homeDir,
      configPath: this.configPath,
      kimiRequestHeaders: this.createKimiRequestHeaders(),
      resolveOAuthTokenProvider:
        options.resolveOAuthTokenProvider ?? this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      telemetry: this.telemetry,
      appVersion: this.identity?.version,
      uiMode: options.uiMode,
    });
    this.core = core;
    this._v2Runtime = runtime;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return sdkRpc(new ClientAPI(this as any));
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
    await this._v2Runtime?.close();
  }

  protected async getRpc(): Promise<ResolvedCoreAPI> {
    return this.ready;
  }

  override async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    const { planMode, ...coreInput } = input;
    void planMode;
    return this.core.createSessionWithOverrides(coreInput, { kaos, persistenceKaos }) as SessionSummary;
  }

  override async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    return this.core.resumeSessionWithOverrides(
      { ...input, sessionId: input.id },
      { kaos, persistenceKaos },
    ) as ResumedSessionSummary;
  }

  private createKimiRequestHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir: this.homeDir,
      ...this.identity,
    });
  }
}

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClient(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    // core is booted asynchronously — fall back to undefined when it is not
    // yet set (imageLimits is optional and consumers guard for undefined).
    imageLimits: (rpc.core as CoreShim | undefined)?.imageLimits,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
