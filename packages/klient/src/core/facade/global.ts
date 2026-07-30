/**
 * The `global` facade — aggregated, single-object-param methods over the
 * engine's app-scope services. Each method maps to one underlying service
 * call (except `env()`, which fans out and merges); the `Caller` underneath
 * applies contract validation and hands the call to the transport. Facade
 * code never sees service tokens, scope routing, or transport details.
 */

import type {
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import type {
  ExportSessionPayload,
  ExportSessionResult,
} from '@moonshot-ai/agent-core-v2/app/sessionExport/sessionExport';
import type { SessionMeta } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { Page } from '@moonshot-ai/agent-core-v2/persistence/interface/queryStore';
import type {
  Workspace,
  WorkspaceUpdate,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import type {
  ConfigDiagnostic,
  ConfigInspectValue,
  ConfigTarget,
} from '@moonshot-ai/agent-core-v2/app/config/config';
import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import type {
  AuthStatus,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import type { ExperimentalFeatureState } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import type { ModelRecord } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import type { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import type { BindAgentInput } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { McpServerConfig } from '@moonshot-ai/agent-core-v2/agent/mcp/config-schema';
import type {
  DeleteSnapshotInput,
  ForkSnapshotInput,
  ForkSnapshotResult,
} from '@moonshot-ai/agent-core-v2/app/sessionStore/sessionSnapshotStore';
import type { McpCatalogEntry } from '@moonshot-ai/agent-core-v2/app/mcpCatalog/mcpCatalog';
import type { McpBeginAuthorizationFlowResult } from '@moonshot-ai/agent-core-v2/app/mcpOAuth/mcpOAuth';
import type { McpProbeResult } from '@moonshot-ai/agent-core-v2/app/mcpProbe/mcpProbe';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';

import type { AnonymousProviderInput, GenerateEvent, GenerateInput, GenerateParams, ProviderInput } from './kosong-types.js';
import type {
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from '@moonshot-ai/agent-core-v2/app/plugin/types';

/** Low-level caller the klient factory builds: routes + validates one service call. */
export type Caller = (service: string, method: string, args: unknown[]) => Promise<unknown>;

/** Scoped variant — the factory's real signature; global methods bind the core scope. */
export type ScopedCaller = (
  scope: { readonly sessionId?: string; readonly agentId?: string },
  service: string,
  method: string,
  args: unknown[],
) => Promise<unknown>;

/** Streaming variant of `ScopedCaller` — returns a validated `AsyncIterable`. */
export type ScopedStreamCaller = (
  scope: { readonly sessionId?: string; readonly agentId?: string },
  service: string,
  method: string,
  args: unknown[],
) => AsyncIterable<unknown>;

// ---------------------------------------------------------------------------
// Wire-type aliases for shapes the engine sources from `@moonshot-ai/protocol`
// (not a direct klient dependency) — derived through the service interfaces.
// ---------------------------------------------------------------------------

export type RefreshProviderModelsResponse = Awaited<
  ReturnType<IOAuthService['refreshOAuthProviderModels']>
>;
export type OAuthFlowStart = Awaited<ReturnType<IOAuthService['startLogin']>>;
export type OAuthFlowSnapshot = NonNullable<Awaited<ReturnType<IOAuthService['getFlow']>>>;
export type OAuthLoginCancelResponse = Awaited<ReturnType<IOAuthService['cancelLogin']>>;
export type OAuthLogoutResponse = Awaited<ReturnType<IOAuthService['logout']>>;
export type AuthManagedUsageResult = Awaited<ReturnType<IOAuthService['getManagedUsage']>>;
export type SubmitFeedbackBody = Parameters<IOAuthService['submitFeedback']>[0];
export type SubmitFeedbackResult = Awaited<ReturnType<IOAuthService['submitFeedback']>>;
export type CreateFeedbackUploadUrlBody = Parameters<
  IOAuthService['createFeedbackUploadUrl']
>[0];
export type CreateFeedbackUploadUrlResult = Awaited<
  ReturnType<IOAuthService['createFeedbackUploadUrl']>
>;
export type CompleteFeedbackUploadBody = Parameters<
  IOAuthService['completeFeedbackUpload']
>[0];
export type CompleteFeedbackUploadResult = Awaited<
  ReturnType<IOAuthService['completeFeedbackUpload']>
>;

export type ModelCatalogItem = Awaited<ReturnType<IModelCatalog['listModels']>>[number];
export type ProviderCatalogItem = Awaited<
  ReturnType<IModelCatalog['listProviders']>
>[number];
export type SetDefaultModelResponse = Awaited<
  ReturnType<IModelCatalog['setDefaultModel']>
>;
export type RefreshProviderModelsOptions = NonNullable<
  Parameters<IProviderDiscoveryService['refreshProviderModels']>[0]
>;

/** String-literal form of the engine's `ConfigTarget` enum, so consumers never import the enum value. */
export type ConfigTargetLiteral = `${ConfigTarget}`;

// ---------------------------------------------------------------------------
// Facade interfaces
// ---------------------------------------------------------------------------

export interface GlobalSessionsFacade {
  list(query: SessionListQuery): Promise<Page<SessionSummary>>;
  get(id: string): Promise<SessionSummary | undefined>;
  countActive(workspaceIds: readonly string[]): Promise<number>;
  /**
   * Create a session rooted at `workDir` (the workspace is registered
   * implicitly), optionally titled. A main-agent binding is applied inside
   * lifecycle creation, before tool and extension activation.
   */
  create(input: {
    id?: string;
    workDir: string;
    additionalDirs?: readonly string[];
    mcpServers?: Readonly<Record<string, McpServerConfig>>;
    mainAgentBinding?: BindAgentInput;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionMeta>;
}

export interface GlobalSessionExportFacade {
  export(input: ExportSessionPayload): Promise<ExportSessionResult>;
}

export interface GlobalSessionStoreFacade {
  fork(input: ForkSnapshotInput): Promise<ForkSnapshotResult>;
  delete(input: DeleteSnapshotInput): Promise<void>;
}

export interface GlobalMcpCatalogFacade {
  list(): Promise<readonly McpCatalogEntry[]>;
  get(name: string): Promise<McpCatalogEntry | undefined>;
  add(input: { name: string; config: McpServerConfig }): Promise<McpCatalogEntry>;
  update(input: { name: string; config: McpServerConfig }): Promise<McpCatalogEntry>;
  rename(input: { oldName: string; newName: string }): Promise<McpCatalogEntry>;
  remove(name: string): Promise<void>;
  reset(): Promise<void>;
}

export interface GlobalMcpOAuthFacade {
  begin(input: {
    serverName: string;
    serverUrl: string;
  }): Promise<McpBeginAuthorizationFlowResult>;
  complete(input: { flowId: string; timeoutMs?: number }): Promise<void>;
  cancel(flowId: string): Promise<void>;
  invalidate(input: {
    serverName: string;
    serverUrl: string;
    scope?: 'all' | 'client' | 'tokens' | 'discovery';
  }): Promise<void>;
}

export interface GlobalMcpProbeFacade {
  run(input: {
    serverName: string;
    config: McpServerConfig;
    cwd?: string;
  }): Promise<McpProbeResult>;
}

export interface GlobalMcpFacade {
  readonly catalog: GlobalMcpCatalogFacade;
  readonly oauth: GlobalMcpOAuthFacade;
  readonly probe: GlobalMcpProbeFacade;
}

export interface GlobalWorkspacesFacade {
  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  createOrTouch(input: { root: string; name?: string }): Promise<Workspace>;
  update(input: { id: string; patch: WorkspaceUpdate }): Promise<Workspace | undefined>;
  delete(id: string): Promise<void>;
}

export interface GlobalSkillsFacade {
  listWorkspace(workDir: string): Promise<readonly SkillSummary[]>;
}

export interface GlobalConfigFacade {
  get<T = unknown>(domain: string): Promise<T>;
  getAll(): Promise<Record<string, unknown>>;
  inspect<T = unknown>(domain: string): Promise<ConfigInspectValue<T>>;
  set(input: { domain: string; patch: unknown; target?: ConfigTargetLiteral }): Promise<void>;
  replace(input: {
    domain: string;
    value: unknown;
    target?: ConfigTargetLiteral;
  }): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): Promise<readonly ConfigDiagnostic[]>;
}

export interface GlobalKosongFacade {
  // -- Provider ---------------------------------------------------------
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(id: string): Promise<ProviderCatalogItem>;
  /** Add a named provider (string id + config) or an anonymous single-model provider (object). */
  addProvider(id: string, config: ProviderInput): Promise<void>;
  addProvider(config: AnonymousProviderInput): Promise<void>;
  removeProvider(id: string): Promise<void>;
  refreshProviders(opts?: RefreshProviderModelsOptions): Promise<RefreshProviderModelsResponse>;

  // -- Model ------------------------------------------------------------
  listModels(): Promise<readonly ModelCatalogItem[]>;
  setDefaultModel(id: string): Promise<SetDefaultModelResponse>;

  // -- Generate (streaming) -----------------------------------------------
  generate(
    modelId: string,
    input: GenerateInput,
    params?: GenerateParams,
  ): AsyncIterable<GenerateEvent>;
}

export interface GlobalAuthFacade {
  status(provider?: string): Promise<AuthStatus>;
  summarize(): Promise<readonly AuthStatus[]>;
  ensureReady(model?: string): Promise<void>;
  startLogin(provider?: string): Promise<OAuthFlowStart>;
  flow(provider?: string): Promise<OAuthFlowSnapshot | undefined>;
  cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse>;
  logout(provider?: string): Promise<OAuthLogoutResponse>;
  getManagedUsage(provider?: string): Promise<AuthManagedUsageResult>;
  submitFeedback(
    body: SubmitFeedbackBody,
    provider?: string,
  ): Promise<SubmitFeedbackResult>;
  createFeedbackUploadUrl(
    body: CreateFeedbackUploadUrlBody,
    provider?: string,
  ): Promise<CreateFeedbackUploadUrlResult>;
  completeFeedbackUpload(
    body: CompleteFeedbackUploadBody,
    provider?: string,
  ): Promise<CompleteFeedbackUploadResult>;
  /**
   * @deprecated Use `kosong.refreshProviders({ scope: 'oauth' })` — the
   * kosong facade owns provider-model refresh; this alias remains for one
   * release cycle.
   */
  refreshProviderModels(): Promise<RefreshProviderModelsResponse>;
}

export interface GlobalFlagsFacade {
  list(): Promise<readonly ExperimentalFeatureState[]>;
  enabled(id: string): Promise<boolean>;
  enabledIds(): Promise<readonly string[]>;
  explain(id: string): Promise<ExperimentalFeatureState | undefined>;
  snapshot(): Promise<Record<string, boolean>>;
}

export interface GlobalPluginsFacade {
  list(): Promise<readonly PluginSummary[]>;
  info(id: string): Promise<PluginInfo>;
  install(source: string): Promise<PluginSummary>;
  setEnabled(input: { id: string; enabled: boolean }): Promise<void>;
  setMcpServerEnabled(input: { id: string; server: string; enabled: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<ReloadSummary>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  listCommands(): Promise<readonly PluginCommandDef[]>;
}

export interface GlobalHostFsFacade {
  browse(absPath?: string): Promise<FsBrowseResponse>;
  home(): Promise<FsHomeResponse>;
}

/** Aggregated host/environment snapshot (`bootstrapService` properties). */
export interface KlientEnvInfo {
  readonly platform: string;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly clientVersion: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
}

export interface GlobalFacade {
  readonly sessions: GlobalSessionsFacade;
  readonly sessionExport: GlobalSessionExportFacade;
  readonly sessionStore: GlobalSessionStoreFacade;
  readonly mcp: GlobalMcpFacade;
  readonly skills: GlobalSkillsFacade;
  readonly workspaces: GlobalWorkspacesFacade;
  readonly config: GlobalConfigFacade;
  readonly kosong: GlobalKosongFacade;
  readonly auth: GlobalAuthFacade;
  readonly flags: GlobalFlagsFacade;
  readonly plugins: GlobalPluginsFacade;
  readonly hostFs: GlobalHostFsFacade;
  env(): Promise<KlientEnvInfo>;
}

// ---------------------------------------------------------------------------
// Implementation — thin reshaping over `Caller`. Casts are safe by
// construction: the contract validates outputs, and type-parity assertions
// tie every contract schema to its engine type.
// ---------------------------------------------------------------------------

const ENV_PROPERTIES = [
  'platform',
  'arch',
  'cwd',
  'osHomeDir',
  'homeDir',
  'configPath',
  'clientVersion',
  'sessionsDir',
  'blobsDir',
  'storeDir',
  'cacheDir',
  'logsDir',
] as const;

export function createGlobalFacade(scoped: ScopedCaller, scopedStream: ScopedStreamCaller): GlobalFacade {
  const call: Caller = (service, method, args) => scoped({}, service, method, args);
  const streamCall = (service: string, method: string, args: unknown[]) =>
    scopedStream({}, service, method, args);
  // The bootstrap snapshot is frozen at process start, so the aggregated
  // env() result can never change — resolve it once and reuse the promise.
  let envPromise: Promise<KlientEnvInfo> | undefined;
  const env = (): Promise<KlientEnvInfo> => {
    envPromise ??= Promise.all(
      ENV_PROPERTIES.map((prop) => call('bootstrapService', prop, []) as Promise<string>),
    ).then(
      (values) =>
        Object.fromEntries(
          ENV_PROPERTIES.map((prop, index) => [prop, values[index]]),
        ) as unknown as KlientEnvInfo,
    );
    return envPromise;
  };

  return {
    sessions: {
      list: (query) => call('sessionIndex', 'list', [query]) as Promise<Page<SessionSummary>>,
      get: (id) => call('sessionIndex', 'get', [id]) as Promise<SessionSummary | undefined>,
      countActive: (workspaceIds) =>
        call('sessionIndex', 'countActive', [workspaceIds]) as Promise<number>,
      create: async ({
        id,
        workDir,
        additionalDirs,
        mcpServers,
        mainAgentBinding,
        title,
        metadata,
      }) => {
        const handle = (await scoped({}, 'sessionLifecycleService', 'create', [
          {
            sessionId: id,
            workDir,
            additionalDirs,
            mcpServers,
            mainAgentBinding,
            title,
            metadata,
          },
        ])) as { id: string };
        const scope = { sessionId: handle.id };
        return scoped(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
      },
    },

    sessionExport: {
      export: (input) =>
        call('sessionExportService', 'export', [input]) as Promise<ExportSessionResult>,
    },

    sessionStore: {
      fork: (input) =>
        call('sessionSnapshotStore', 'fork', [input]) as Promise<ForkSnapshotResult>,
      delete: (input) =>
        call('sessionLifecycleService', 'delete', [input]) as Promise<void>,
    },

    mcp: {
      catalog: {
        list: () =>
          call('mcpCatalogService', 'list', []) as Promise<readonly McpCatalogEntry[]>,
        get: (name) =>
          call('mcpCatalogService', 'get', [name]) as Promise<McpCatalogEntry | undefined>,
        add: ({ name, config }) =>
          call('mcpCatalogService', 'add', [name, config]) as Promise<McpCatalogEntry>,
        update: ({ name, config }) =>
          call('mcpCatalogService', 'update', [name, config]) as Promise<McpCatalogEntry>,
        rename: ({ oldName, newName }) =>
          call('mcpCatalogService', 'rename', [oldName, newName]) as Promise<McpCatalogEntry>,
        remove: (name) =>
          call('mcpCatalogService', 'remove', [name]) as Promise<void>,
        reset: () => call('mcpCatalogService', 'reset', []) as Promise<void>,
      },
      oauth: {
        begin: ({ serverName, serverUrl }) =>
          call('mcpOAuthService', 'beginAuthorizationWithFlowId', [
            serverName,
            serverUrl,
          ]) as Promise<McpBeginAuthorizationFlowResult>,
        complete: ({ flowId, timeoutMs }) =>
          call('mcpOAuthService', 'completeAuthorization', [
            flowId,
            { timeoutMs },
          ]) as Promise<void>,
        cancel: (flowId) =>
          call('mcpOAuthService', 'cancelAuthorization', [flowId]) as Promise<void>,
        invalidate: ({ serverName, serverUrl, scope }) =>
          call('mcpOAuthService', 'invalidate', [
            serverName,
            serverUrl,
            scope,
          ]) as Promise<void>,
      },
      probe: {
        run: ({ serverName, config, cwd }) =>
          call('mcpProbeService', 'probe', [serverName, config, { cwd }]) as Promise<McpProbeResult>,
      },
    },

    skills: {
      listWorkspace: (workDir) =>
        call('workspaceSkillCatalogService', 'list', [workDir]) as Promise<
          readonly SkillSummary[]
        >,
    },

    workspaces: {
      list: () => call('workspaceService', 'list', []) as Promise<readonly Workspace[]>,
      get: (id) => call('workspaceService', 'get', [id]) as Promise<Workspace | undefined>,
      createOrTouch: ({ root, name }) =>
        call('workspaceService', 'createOrTouch', [root, name]) as Promise<Workspace>,
      update: ({ id, patch }) =>
        call('workspaceService', 'update', [id, patch]) as Promise<Workspace | undefined>,
      delete: (id) => call('workspaceService', 'delete', [id]) as Promise<void>,
    },

    config: {
      get: <T>(domain: string) => call('configService', 'get', [domain]) as Promise<T>,
      getAll: () => call('configService', 'getAll', []) as Promise<Record<string, unknown>>,
      inspect: <T>(domain: string) =>
        call('configService', 'inspect', [domain]) as Promise<ConfigInspectValue<T>>,
      set: ({ domain, patch, target }) =>
        call('configService', 'set', [domain, patch, target]) as Promise<void>,
      replace: ({ domain, value, target }) =>
        call('configService', 'replace', [domain, value, target]) as Promise<void>,
      reload: () => call('configService', 'reload', []) as Promise<void>,
      diagnostics: () =>
        call('configService', 'diagnostics', []) as Promise<readonly ConfigDiagnostic[]>,
    },

    kosong: {
      listProviders: () =>
        call('modelResolver', 'listProviders', []) as Promise<
          readonly ProviderCatalogItem[]
        >,
      getProvider: (id) =>
        call('modelResolver', 'getProvider', [id]) as Promise<ProviderCatalogItem>,
      addProvider: ((
        idOrConfig: string | AnonymousProviderInput,
        maybeConfig?: ProviderInput,
      ): Promise<void> => {
        if (typeof idOrConfig === 'string') {
          // Named provider — map ProviderInput to ProviderConfig wire shape.
          const config = maybeConfig!;
          const wire: ProviderConfig = {
            type: config.type,
            baseUrl: config.baseUrl,
            defaultModel: config.defaultModel,
            apiKey: config.auth.method === 'api-key' ? config.auth.apiKey : '',
          };
          return call('providerService', 'set', [idOrConfig, wire]) as Promise<void>;
        }
        // Anonymous provider — map AnonymousProviderInput to ModelRecord wire shape.
        const anon = idOrConfig;
        const capabilities = anon.capabilities
          ? Object.entries(anon.capabilities)
              .filter(([, v]) => v)
              .map(([k]) => k)
          : undefined;
        const wire: ModelRecord = {
          model: anon.model,
          protocol: anon.protocol as ModelRecord['protocol'],
          baseUrl: anon.baseUrl,
          apiKey: anon.auth.method === 'api-key' ? anon.auth.apiKey : '',
          displayName: anon.displayName,
          maxContextSize: anon.maxContextSize,
          capabilities,
        };
        return call('modelService', 'set', [anon.id, wire]) as Promise<void>;
      }) as GlobalKosongFacade['addProvider'],
      removeProvider: async (id) => {
        // Try provider registry first; fall back to model registry.
        const existing = await call('providerService', 'get', [id]);
        if (existing !== undefined) {
          return call('providerService', 'delete', [id]) as Promise<void>;
        }
        return call('modelService', 'delete', [id]) as Promise<void>;
      },
      refreshProviders: (opts) =>
        call('providerDiscovery', 'refreshProviderModels', [
          opts,
        ]) as Promise<RefreshProviderModelsResponse>,

      listModels: () =>
        call('modelResolver', 'listModels', []) as Promise<readonly ModelCatalogItem[]>,
      setDefaultModel: (id) =>
        call('modelResolver', 'setDefaultModel', [id]) as Promise<SetDefaultModelResponse>,

      generate: (modelId, input, params) =>
        streamCall('modelResolver', 'generate', [modelId, input, params]) as AsyncIterable<GenerateEvent>,
    },

    auth: {
      status: (provider) => call('oauthService', 'status', [provider]) as Promise<AuthStatus>,
      summarize: () => call('authSummaryService', 'summarize', []) as Promise<readonly AuthStatus[]>,
      ensureReady: (model) =>
        call('authSummaryService', 'ensureReady', [model]) as Promise<void>,
      startLogin: (provider) =>
        call('oauthService', 'startLogin', [provider]) as Promise<OAuthFlowStart>,
      flow: (provider) =>
        call('oauthService', 'getFlow', [provider]) as Promise<OAuthFlowSnapshot | undefined>,
      cancelLogin: (provider) =>
        call('oauthService', 'cancelLogin', [provider]) as Promise<OAuthLoginCancelResponse>,
      logout: (provider) =>
        call('oauthService', 'logout', [provider]) as Promise<OAuthLogoutResponse>,
      getManagedUsage: (provider) =>
        call('oauthService', 'getManagedUsage', [provider]) as Promise<AuthManagedUsageResult>,
      submitFeedback: (body, provider) =>
        call('oauthService', 'submitFeedback', [body, provider]) as Promise<SubmitFeedbackResult>,
      createFeedbackUploadUrl: (body, provider) =>
        call('oauthService', 'createFeedbackUploadUrl', [
          body,
          provider,
        ]) as Promise<CreateFeedbackUploadUrlResult>,
      completeFeedbackUpload: (body, provider) =>
        call('oauthService', 'completeFeedbackUpload', [
          body,
          provider,
        ]) as Promise<CompleteFeedbackUploadResult>,
      refreshProviderModels: () =>
        call('oauthService', 'refreshOAuthProviderModels', []) as Promise<RefreshProviderModelsResponse>,
    },

    flags: {
      list: () => call('flagService', 'explainAll', []) as Promise<readonly ExperimentalFeatureState[]>,
      enabled: (id) => call('flagService', 'enabled', [id]) as Promise<boolean>,
      enabledIds: () => call('flagService', 'enabledIds', []) as Promise<readonly string[]>,
      explain: (id) =>
        call('flagService', 'explain', [id]) as Promise<ExperimentalFeatureState | undefined>,
      snapshot: () => call('flagService', 'snapshot', []) as Promise<Record<string, boolean>>,
    },

    plugins: {
      list: () => call('pluginService', 'listPlugins', []) as Promise<readonly PluginSummary[]>,
      info: (id) => call('pluginService', 'getPluginInfo', [{ id }]) as Promise<PluginInfo>,
      install: (source) =>
        call('pluginService', 'installPlugin', [{ source }]) as Promise<PluginSummary>,
      setEnabled: (input) => call('pluginService', 'setPluginEnabled', [input]) as Promise<void>,
      setMcpServerEnabled: (input) =>
        call('pluginService', 'setPluginMcpServerEnabled', [input]) as Promise<void>,
      remove: (id) => call('pluginService', 'removePlugin', [{ id }]) as Promise<void>,
      reload: () => call('pluginService', 'reloadPlugins', []) as Promise<ReloadSummary>,
      checkUpdates: () =>
        call('pluginService', 'checkUpdates', []) as Promise<readonly PluginUpdateStatus[]>,
      listCommands: () =>
        call('pluginService', 'listPluginCommands', []) as Promise<readonly PluginCommandDef[]>,
    },

    hostFs: {
      browse: (absPath) =>
        call('hostFolderBrowser', 'browse', [absPath]) as Promise<FsBrowseResponse>,
      home: () => call('hostFolderBrowser', 'home', []) as Promise<FsHomeResponse>,
    },

    env,
  };
}
