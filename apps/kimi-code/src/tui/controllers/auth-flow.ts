import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '../constant/kimi-tui';
import type { RuntimeModelCatalogSnapshot } from '../runtime/runtime-model-catalog-port';
import type {
  RuntimeProviderRefreshResult,
  RuntimeProviderRefreshScope,
} from '../runtime/runtime-provider-refresh-port';
import type { SessionCreateInput } from '../runtime/session-control-port';
import type { TUIRuntime } from '../runtime/tui-runtime';
import type { TUISessionRuntime } from '../runtime/tui-session-runtime';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import type { SessionEventHandler } from './session-event-handler';
import type { AppState, KimiTUIOptions } from '../types';
import type { TUIState } from '../tui-state';

function appStateCatalogFromSnapshot(
  snapshot: RuntimeModelCatalogSnapshot,
): Pick<AppState, 'availableModels' | 'availableProviders'> {
  const availableProviders: AppState['availableProviders'] = {};
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (!isAppStateProviderType(provider.type)) continue;
    availableProviders[id] = {
      type: provider.type,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      env: provider.env,
      customHeaders: provider.customHeaders,
      source: provider.source,
    };
  }
  return {
    availableModels: snapshot.models,
    availableProviders,
  };
}

function isAppStateProviderType(
  type: string,
): type is AppState['availableProviders'][string]['type'] {
  switch (type) {
    case 'anthropic':
    case 'google-genai':
    case 'kimi':
    case 'openai':
    case 'openai_responses':
    case 'vertexai':
      return true;
    default:
      return false;
  }
}

export interface AuthFlowHost {
  state: TUIState;
  readonly options: KimiTUIOptions;
  readonly runtime: Pick<TUIRuntime, 'models' | 'providerRefresh'>;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  requireSessionRuntime(): TUISessionRuntime;
  createAndBindSession(input: SessionCreateInput): Promise<TUISessionRuntime>;
  syncRuntimeState(): Promise<void>;
  closeSession(reason: string): Promise<void>;
  appendStartupNotice(extra: string): void;
  readonly sessionEventHandler: SessionEventHandler;
  fetchSessions(): Promise<void>;
  updateTerminalTitle(): void;
  refreshSkillCommands(): Promise<void>;
  refreshPluginCommands(): Promise<void>;
}

export class AuthFlowController {
  constructor(private readonly host: AuthFlowHost) {}

  async refreshAvailableModels(): Promise<void> {
    const config = await this.host.runtime.models.load({ reload: true });
    this.host.setAppState(appStateCatalogFromSnapshot(config));
  }

  enterLoginRequiredStartupState(): void {
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
    this.host.appendStartupNotice(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    this.host.setStartupReady();
  }

  async activateModelAfterLogin(model: string, effort?: string): Promise<void> {
    const { host } = this;
    let activeRuntime: TUISessionRuntime | undefined;
    try {
      activeRuntime = host.requireSessionRuntime();
    } catch {
      activeRuntime = undefined;
    }
    if (activeRuntime !== undefined) {
      await activeRuntime.agent.setModel(model);
      if (effort !== undefined) {
        await activeRuntime.agent.setThinking(effort);
      }
      return;
    }

    const options: SessionCreateInput = {
      workDir: host.state.appState.workDir,
      model,
      thinking: effort,
      permission: host.options.startup.auto
        ? 'auto'
        : host.options.startup.yolo
          ? 'yolo'
          : undefined,
      planMode: host.state.appState.planMode ? true : undefined,
      additionalDirs:
        host.state.appState.additionalDirs.length === 0
          ? undefined
          : [...host.state.appState.additionalDirs],
    };
    const sessionRuntime = await host.createAndBindSession(options);
    const identity = await sessionRuntime.lifecycle.getIdentity();
    host.setAppState({
      sessionId: identity.id,
      sessionTitle: identity.title ?? null,
    });
    await host.syncRuntimeState();
    host.sessionEventHandler.startSubscription();
    void host.fetchSessions();
    host.updateTerminalTitle();
    void host.refreshSkillCommands();
    void host.refreshPluginCommands();
  }

  async clearActiveSessionAfterLogout(): Promise<void> {
    await this.host.closeSession('logged out');
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    await this.host.refreshSkillCommands();
    await this.host.refreshPluginCommands();
  }

  async refreshConfigAfterLogin(): Promise<void> {
    const { host } = this;
    const config = await host.runtime.models.load({ reload: true });
    const { availableModels, availableProviders } = appStateCatalogFromSnapshot(config);
    const defaultModel = host.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      host.setAppState({ availableModels, availableProviders });
      return;
    }

    await this.activateModelAfterLogin(defaultModel, thinkingEffortFromConfig(config.thinking));
    const appStatePatch: Partial<AppState> = {
      availableModels,
      availableProviders,
      model: defaultModel,
      maxContextTokens: selected.maxContextSize,
    };
    host.setAppState(appStatePatch);
  }

  async refreshConfigAfterLogout(): Promise<void> {
    const config = await this.host.runtime.models.load({ reload: true });
    this.host.setAppState({
      ...appStateCatalogFromSnapshot(config),
      model: '',
      thinkingEffort: 'off',
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  }

  /**
   * Re-fetch model lists from every provider whose upstream supports it
   * (managed OAuth, open platforms, custom registries) and update local
   * config.  Runs best-effort: individual provider failures are collected
   * and returned instead of thrown.
   */
  async refreshProviderModels(): Promise<RuntimeProviderRefreshResult> {
    return this.refreshProviderModelsWithScope('all');
  }

  async refreshOAuthProviderModels(): Promise<RuntimeProviderRefreshResult> {
    return this.refreshProviderModelsWithScope('oauth');
  }

  private async refreshProviderModelsWithScope(
    scope: RuntimeProviderRefreshScope,
  ): Promise<RuntimeProviderRefreshResult> {
    const { host } = this;
    const result = await host.runtime.providerRefresh.refresh(scope);
    if (result.changed.length > 0) {
      await this.refreshAvailableModels();
    }
    return result;
  }
}
