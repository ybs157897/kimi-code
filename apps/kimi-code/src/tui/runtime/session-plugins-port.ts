/**
 * Runtime-neutral plugin management used by the interactive TUI.
 *
 * The views intentionally contain only the fields read by the plugin command
 * flow and its panels. Runtime adapters copy their wire-owned values into
 * these shapes so the UI does not retain SDK or Klient objects.
 */

export type PluginSourceView = 'local-path' | 'zip-url' | 'github';
export type PluginStateView = 'ok' | 'error';
export type PluginManifestKindView =
  | 'kimi-plugin-root'
  | 'kimi-plugin-dir'
  | 'codebuddy-plugin-dir';

export interface PluginGithubRefView {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export interface PluginGithubMetadataView {
  readonly owner: string;
  readonly repo: string;
  readonly ref: PluginGithubRefView;
  readonly installedSha?: string;
}

export interface PluginSummaryView {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginStateView;
  readonly skillCount: number;
  readonly mcpServerCount: number;
  readonly enabledMcpServerCount: number;
  readonly hasErrors: boolean;
  readonly source: PluginSourceView;
  readonly originalSource?: string;
  readonly github?: PluginGithubMetadataView;
}

export interface PluginManifestView {
  readonly keywords?: readonly string[];
  readonly skills?: readonly string[];
  readonly sessionStart?: {
    readonly skill: string;
  };
  readonly skillInstructions?: string;
  readonly interface?: {
    readonly shortDescription?: string;
    readonly developerName?: string;
    readonly websiteURL?: string;
  };
}

export interface PluginMcpServerView {
  readonly name: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface PluginDiagnosticView {
  readonly severity: 'error' | 'warn' | 'info';
  readonly message: string;
}

export interface PluginInfoView extends PluginSummaryView {
  readonly root: string;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly manifestKind?: PluginManifestKindView;
  readonly manifestPath?: string;
  readonly manifest?: PluginManifestView;
  readonly mcpServers: readonly PluginMcpServerView[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnosticView[];
}

export interface ReloadSummaryView {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{
    readonly id: string;
    readonly message: string;
  }>;
}

export interface SessionPluginsPort {
  list(): Promise<readonly PluginSummaryView[]>;
  info(id: string): Promise<PluginInfoView>;
  install(source: string): Promise<PluginSummaryView>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<ReloadSummaryView>;
}

export function copyPluginSummaryView(
  plugin: PluginSummaryView,
): PluginSummaryView {
  return {
    id: plugin.id,
    displayName: plugin.displayName,
    version: plugin.version,
    enabled: plugin.enabled,
    state: plugin.state,
    skillCount: plugin.skillCount,
    mcpServerCount: plugin.mcpServerCount,
    enabledMcpServerCount: plugin.enabledMcpServerCount,
    hasErrors: plugin.hasErrors,
    source: plugin.source,
    originalSource: plugin.originalSource,
    github:
      plugin.github === undefined
        ? undefined
        : {
            owner: plugin.github.owner,
            repo: plugin.github.repo,
            ref: {
              kind: plugin.github.ref.kind,
              value: plugin.github.ref.value,
            },
            installedSha: plugin.github.installedSha,
          },
  };
}

export function copyPluginInfoView(plugin: PluginInfoView): PluginInfoView {
  return {
    ...copyPluginSummaryView(plugin),
    root: plugin.root,
    installedAt: plugin.installedAt,
    updatedAt: plugin.updatedAt,
    manifestKind: plugin.manifestKind,
    manifestPath: plugin.manifestPath,
    manifest:
      plugin.manifest === undefined
        ? undefined
        : {
            keywords:
              plugin.manifest.keywords === undefined
                ? undefined
                : [...plugin.manifest.keywords],
            skills:
              plugin.manifest.skills === undefined
                ? undefined
                : [...plugin.manifest.skills],
            sessionStart:
              plugin.manifest.sessionStart === undefined
                ? undefined
                : { skill: plugin.manifest.sessionStart.skill },
            skillInstructions: plugin.manifest.skillInstructions,
            interface:
              plugin.manifest.interface === undefined
                ? undefined
                : {
                    shortDescription:
                      plugin.manifest.interface.shortDescription,
                    developerName: plugin.manifest.interface.developerName,
                    websiteURL: plugin.manifest.interface.websiteURL,
                  },
          },
    mcpServers: plugin.mcpServers.map((server) => ({
      name: server.name,
      runtimeName: server.runtimeName,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command,
      args: server.args === undefined ? undefined : [...server.args],
      cwd: server.cwd,
      url: server.url,
      envKeys:
        server.envKeys === undefined ? undefined : [...server.envKeys],
      headerKeys:
        server.headerKeys === undefined ? undefined : [...server.headerKeys],
    })),
    shadowedManifestPath: plugin.shadowedManifestPath,
    diagnostics: plugin.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  };
}

export function copyReloadSummaryView(
  summary: ReloadSummaryView,
): ReloadSummaryView {
  return {
    added: [...summary.added],
    removed: [...summary.removed],
    errors: summary.errors.map((error) => ({
      id: error.id,
      message: error.message,
    })),
  };
}
