import { currentTheme, lightColors } from '#/tui/theme';
import { loadTuiConfig, type TuiConfig } from '../config';
import type { RuntimeModelCatalogSnapshot } from '../runtime/runtime-model-catalog-port';
import type { TUISessionRuntime } from '../runtime/tui-session-runtime';
import type { AppState } from '../types';
import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';

interface ReloadCommandRefreshHost {
  refreshSkillCommands(): Promise<void>;
  refreshPluginCommands(): Promise<void>;
  refreshExtensionCommands(): Promise<void>;
}

export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig();
  await applyReloadedTuiConfig(host, tuiConfig);
  host.showStatus('TUI config reloaded.', 'success');
}

export async function handleReloadCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig();
  const sessionRuntime = tryActiveSessionRuntime(host);

  if (sessionRuntime !== undefined) {
    await reloadActiveSessionRuntime(host, sessionRuntime);
    await host.reloadCurrentSessionView('Session reloaded.');
  }

  const [catalog, features] = await Promise.all([
    host.runtime.models.load({ reload: true }),
    host.runtime.featureFlags.list(),
  ]);
  setExperimentalFeatures(features);
  host.refreshSlashCommandAutocomplete();
  applyRuntimeCatalog(host, catalog);
  await applyReloadedTuiConfig(host, tuiConfig);

  if (sessionRuntime === undefined) {
    host.showStatus(
      'Runtime and TUI config reloaded; no active session.',
      'success',
    );
  }
}

export async function applyReloadedTuiConfig(
  host: SlashCommandHost,
  config: TuiConfig,
): Promise<void> {
  const resolved = config.theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(config.theme, resolved);
  host.refreshTerminalThemeTracking();
  host.setAppState({
    editorCommand: config.editorCommand,
    disablePasteBurst: config.disablePasteBurst,
    notifications: config.notifications,
    upgrade: config.upgrade,
  });
  host.state.editor.setDisablePasteBurst(config.disablePasteBurst);
}

async function reloadActiveSessionRuntime(
  host: SlashCommandHost,
  runtime: TUISessionRuntime,
): Promise<void> {
  await runtime.refresh.reload();

  const refreshHost = host as SlashCommandHost & ReloadCommandRefreshHost;
  await refreshHost.refreshSkillCommands();
  await refreshHost.refreshPluginCommands();
  await refreshHost.refreshExtensionCommands();
}

function tryActiveSessionRuntime(
  host: SlashCommandHost,
): TUISessionRuntime | undefined {
  try {
    return host.requireSessionRuntime();
  } catch {
    return undefined;
  }
}

function applyRuntimeCatalog(
  host: SlashCommandHost,
  catalog: RuntimeModelCatalogSnapshot,
): void {
  const availableProviders: AppState['availableProviders'] = {};
  for (const [id, provider] of Object.entries(catalog.providers)) {
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
  host.setAppState({
    availableModels: catalog.models,
    availableProviders,
  });
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
