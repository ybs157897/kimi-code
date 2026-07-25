/**
 * Extension manager — App-scoped owner of loaded code-based extensions.
 *
 * Mirrors the shape of v1's `PluginManager` so `core-impl` can hold it the
 * same way (load on startup, reload on `/reload`, expose `enabledCommands()`
 * for session construction). Unlike plugins, extensions are code: the manager
 * discovers and loads TS/JS files with jiti and keeps the in-memory
 * `Extension` objects that the per-session `ExtensionRunner` dispatches to.
 */

import * as path from 'node:path';

import { discoverAndLoadExtensions } from './loader';
import { ExtensionRunner } from './runner';
import type {
  Extension,
  ExtensionCommandDef,
  LoadExtensionsResult,
} from './types';

export interface ExtensionManagerOptions {
  readonly homeDir: string;
  /** Extra paths (files or directories) beyond auto-discovered locations. */
  readonly extraPaths?: readonly string[];
}

export interface ExtensionReloadSummary {
  /** Resolved paths of extensions now active. */
  readonly active: readonly string[];
  readonly errors: LoadExtensionsResult['errors'];
}

export class ExtensionManager {
  private readonly homeDir: string;
  private readonly extraPaths: readonly string[];
  private current: LoadExtensionsResult = { extensions: [], errors: [] };

  constructor(options: ExtensionManagerOptions) {
    this.homeDir = options.homeDir;
    this.extraPaths = options.extraPaths ?? [];
  }

  /**
   * Load extensions for a given working directory. Project-local extensions
   * are discovered under `<cwd>/.kimi-code/extensions/`, global extensions
   * under `<homeDir>/extensions/`, plus any configured extra paths.
   */
  async load(cwd: string): Promise<LoadExtensionsResult> {
    this.current = await discoverAndLoadExtensions(this.extraPaths, cwd, this.homeDir);
    return this.current;
  }

  /** Currently loaded extensions (shallow copy). */
  list(): readonly Extension[] {
    return [...this.current.extensions];
  }

  /** Load errors from the last load() call. */
  errors(): LoadExtensionsResult['errors'] {
    return this.current.errors;
  }

  /**
   * Reload (re-discover + re-load) extensions for a working directory. Called
   * from the `/reload` chain so edited extension files take effect.
   */
  async reload(cwd: string): Promise<ExtensionReloadSummary> {
    await this.load(cwd);
    return {
      active: this.current.extensions.map((e) => e.path),
      errors: this.current.errors,
    };
  }

  /** Slash commands contributed by all loaded extensions. */
  enabledCommands(): readonly ExtensionCommandDef[] {
    const defs: ExtensionCommandDef[] = [];
    for (const ext of this.current.extensions) {
      for (const command of ext.commands.values()) {
        defs.push({
          extensionId: ext.id,
          name: command.name,
          description: command.description,
        });
      }
    }
    return defs;
  }

  /** Lookup a command by its namespaced name `<extensionId>:<commandName>`. */
  resolveCommand(namespacedName: string): { extension: Extension; commandName: string } | undefined {
    const sepIndex = namespacedName.indexOf(':');
    if (sepIndex <= 0) return undefined;
    const extensionId = namespacedName.slice(0, sepIndex);
    const commandName = namespacedName.slice(sepIndex + 1);
    for (const ext of this.current.extensions) {
      if (ext.id !== extensionId) continue;
      if (ext.commands.has(commandName)) return { extension: ext, commandName };
    }
    return undefined;
  }

  /** Build a fresh runner for one session over the currently loaded extensions. */
  createRunner(): ExtensionRunner {
    return new ExtensionRunner(this.current.extensions);
  }

  /** Absolute path resolution helper (exposed for tests). */
  resolveLocalExtensionsDir(cwd: string): string {
    return path.join(cwd, '.kimi-code', 'extensions');
  }
}
