/**
 * `extension` domain (L3) — `IExtensionLoaderService` implementation.
 *
 * Discovers workspace and home-directory extension entry points through
 * `hostFs`, evaluates TypeScript or JavaScript factories with `jiti`, and
 * returns independent contribution objects for each Session. Reads home
 * layout from `bootstrap`. Bound at App scope.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { TransformOptions, TransformResult } from 'jiti';
import { createJiti } from 'jiti';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type {
  ExtensionAPI,
  ExtensionEventName,
  ExtensionFactory,
  ExtensionHandler,
  ExtensionLoadError,
  ExtensionLoadResult,
  ExtensionManifest,
  ExtensionTool,
  LoadedExtension,
} from './extension.types';
import { IExtensionLoaderService, type LoadExtensionsInput } from './extensionLoader';

const CONFIG_DIR_NAME = '.kimi-code';
const EXTENSION_FILE_SUFFIXES = ['.ts', '.js', '.mjs'] as const;

interface RegistrationAPI {
  on(event: string, handler: ExtensionHandler): void;
  registerTool(tool: ExtensionTool): void;
  registerCommand(
    name: string,
    command: { readonly description: string; readonly prompt?: (args: string) => string | Promise<string> },
  ): void;
}

export class ExtensionLoaderService implements IExtensionLoaderService {
  declare readonly _serviceBrand: undefined;

  private readonly aliases: Record<string, string>;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {
    const hostApi = resolveExtensionHostApi();
    this.aliases = {
      '@moonshot-ai/agent-core/extension': hostApi,
      '@moonshot-ai/agent-core-v2/extension': hostApi,
    };
  }

  async load(input: LoadExtensionsInput): Promise<ExtensionLoadResult> {
    const paths = await this.discover(input.cwd);
    const extensions: LoadedExtension[] = [];
    const errors: ExtensionLoadError[] = [];
    for (const extensionPath of paths) {
      const loaded = await this.loadOne(extensionPath);
      if (loaded.extension !== undefined) extensions.push(loaded.extension);
      if (loaded.error !== undefined) errors.push(loaded.error);
    }
    return { extensions, errors };
  }

  private async discover(cwd: string): Promise<readonly string[]> {
    const candidates = [
      ...(await this.discoverDirectory(path.join(cwd, CONFIG_DIR_NAME, 'extensions'))),
      ...(await this.discoverDirectory(path.join(this.bootstrap.homeDir, 'extensions'))),
    ];
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  }

  private async discoverDirectory(directory: string): Promise<readonly string[]> {
    let entries;
    try {
      entries = await this.fs.readdir(directory);
    } catch {
      return [];
    }

    const discovered: string[] = [];
    for (const entry of [...entries].toSorted((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if ((entry.isFile || entry.isSymbolicLink === true) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }
      if (entry.isDirectory || entry.isSymbolicLink === true) {
        const nested = await this.resolveDirectoryEntries(entryPath);
        if (nested !== undefined) discovered.push(...nested);
      }
    }
    return discovered;
  }

  private async resolveDirectoryEntries(directory: string): Promise<readonly string[] | undefined> {
    const manifest = await this.readManifest(path.join(directory, 'package.json'));
    if (manifest?.extensions !== undefined) {
      const declared: string[] = [];
      for (const entry of manifest.extensions) {
        const resolved = path.resolve(directory, entry);
        if (await this.exists(resolved)) declared.push(resolved);
      }
      if (declared.length > 0) return declared;
    }

    for (const indexName of ['index.ts', 'index.js', 'index.mjs']) {
      const indexPath = path.join(directory, indexName);
      if (await this.exists(indexPath)) return [indexPath];
    }
    return undefined;
  }

  private async readManifest(manifestPath: string): Promise<ExtensionManifest | undefined> {
    try {
      const parsed = JSON.parse(await this.fs.readText(manifestPath)) as { kimi?: unknown };
      if (parsed.kimi === null || typeof parsed.kimi !== 'object') return undefined;
      return parsed.kimi as ExtensionManifest;
    } catch {
      return undefined;
    }
  }

  private async exists(candidate: string): Promise<boolean> {
    try {
      await this.fs.stat(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private async loadOne(extensionPath: string): Promise<{
    readonly extension?: LoadedExtension;
    readonly error?: ExtensionLoadError;
  }> {
    try {
      const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        alias: this.aliases,
        interopDefault: true,
        transform: lazyBabelTransform,
      });
      const module = (await jiti.import(extensionPath, { default: true })) as unknown;
      if (typeof module !== 'function') {
        return {
          error: {
            path: extensionPath,
            error: `Extension does not export a factory function: ${extensionPath}`,
          },
        };
      }

      const resolvedPath = path.resolve(extensionPath);
      const extension = createLoadedExtension(extensionPath, resolvedPath);
      await (module as ExtensionFactory)(createRegistrationAPI(extension) as ExtensionAPI);
      return { extension };
    } catch (error) {
      return {
        error: {
          path: extensionPath,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function isExtensionFile(name: string): boolean {
  return EXTENSION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * jiti's default transform lazily requires `jiti/dist/babel.cjs` relative to
 * jiti's own file — a path that does not exist inside a single-file SEA. The
 * desktop sidecar embeds that self-contained bundle as a SEA asset and points
 * `KIMI_JITI_BABEL_PATH` at the materialized file; everywhere else the package
 * layout resolves normally. Supplying the transform explicitly (instead of
 * jiti's own lazy require) is what makes the SEA case work.
 */
// jiti's default transform lazily requires `jiti/dist/babel.cjs` relative to
// jiti's own file — a path that does not exist inside a single-file SEA. The
// desktop sidecar embeds that self-contained bundle as a SEA asset and points
// `KIMI_JITI_BABEL_PATH` at the materialized file; everywhere else the package
// layout resolves normally. Supplying the transform explicitly (instead of
// jiti's own lazy require) is what makes the SEA case work.
let babelTransform: ((opts: TransformOptions) => TransformResult) | undefined;
function lazyBabelTransform(opts: TransformOptions): TransformResult {
  if (babelTransform === undefined) {
    const injected = process.env['KIMI_JITI_BABEL_PATH'];
    // `jiti/dist/babel.cjs` is not covered by jiti's exports map, so resolve
    // the package.json first and join the dist path manually.
    const babelPath =
      injected !== undefined && injected.length > 0
        ? injected
        : path.join(
            path.dirname(createRequire(import.meta.url).resolve('jiti/package.json')),
            'dist',
            'babel.cjs',
          );
    babelTransform = createRequire(import.meta.url)(babelPath) as (
      opts: TransformOptions,
    ) => TransformResult;
  }
  return babelTransform(opts);
}

/**
 * Resolve the extension host API module to a file path jiti can load. Priority:
 *
 *  1. `KIMI_EXTENSION_HOST_API` — an explicit path injected by a host that
 *     cannot resolve the package from disk (the desktop SEA sidecar
 *     materializes the bundled host API chunk and sets this).
 *  2. `createRequire(import.meta.url).resolve(...)` — works in both ESM (tsx
 *     dev) and CJS bundles, unlike `import.meta.resolve`, which bundlers
 *     cannot polyfill in CJS output (tsdown emits a `{}.resolve` that always
 *     throws).
 *  3. A path relative to this module, as a last-resort fallback.
 */
function resolveExtensionHostApi(): string {
  const injected = process.env['KIMI_EXTENSION_HOST_API'];
  if (injected !== undefined && injected.length > 0) return injected;
  try {
    return fileURLToPath(createRequire(import.meta.url).resolve('@moonshot-ai/agent-core-v2/extension'));
  } catch {
    return fileURLToPath(new URL('../../extension.ts', import.meta.url));
  }
}

function createLoadedExtension(extensionPath: string, resolvedPath: string): LoadedExtension {
  return {
    path: extensionPath,
    resolvedPath,
    id: deriveExtensionId(resolvedPath),
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
}

function deriveExtensionId(resolvedPath: string): string {
  const base = path.basename(resolvedPath).replace(/\.(ts|js|mjs)$/, '');
  const sanitized = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return sanitized || 'extension';
}

function createRegistrationAPI(extension: LoadedExtension): RegistrationAPI {
  return {
    on(event, handler) {
      const name = event as ExtensionEventName;
      const handlers = extension.handlers.get(name) ?? [];
      handlers.push(handler);
      extension.handlers.set(name, handlers);
    },
    registerTool(tool) {
      extension.tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      extension.commands.set(name, { ...command, name });
    },
  };
}

registerScopedService(
  LifecycleScope.App,
  IExtensionLoaderService,
  ExtensionLoaderService,
  ScopeActivation.OnScopeCreated,
  'extension',
);
