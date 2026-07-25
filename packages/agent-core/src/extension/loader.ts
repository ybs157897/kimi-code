/**
 * Extension loader — loads TypeScript extension modules using jiti at runtime.
 *
 * Adapted from pi's `core/extensions/loader.ts`. kimi-code has no compiled
 * binary path, so the Bun `virtualModules` branch is dropped; we always use
 * jiti `alias` to expose a curated set of `@moonshot-ai/*` host packages to
 * extension code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJiti } from 'jiti';

import type {
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionFactory,
  ExtensionTool,
  KimiManifest,
  LoadExtensionsResult,
  RegisteredCommand,
} from './types';

/** kimi-code config dir inside a project workspace. */
export const CONFIG_DIR_NAME = '.kimi-code';

/**
 * Host packages made available to extension code via jiti alias. Extensions
 * import from `@moonshot-ai/agent-core/extension` for the public API surface;
 * the other entries let extensions reuse protocol/kosong types without needing
 * a separate install.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
  if (_aliases) return _aliases;

  // loader.ts lives at packages/agent-core/src/extension/loader.ts
  const agentCoreRoot = path.resolve(import.meta.dirname, '../..');
  const monorepoRoot = path.resolve(agentCoreRoot, '../..');

  const extensionHostApi = path.join(agentCoreRoot, 'src', 'extension', 'host-api.ts');
  const agentCoreEntry = path.join(agentCoreRoot, 'src', 'index.ts');

  const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
    const workspacePath = path.join(monorepoRoot, workspaceRelativePath);
    if (fs.existsSync(workspacePath)) return workspacePath;
    try {
      return fileURLToPath(import.meta.resolve(specifier));
    } catch {
      return workspacePath;
    }
  };

  const protocolEntry = resolveWorkspaceOrImport('packages/protocol/src/index.ts', '@moonshot-ai/protocol');
  const kosongEntry = resolveWorkspaceOrImport('packages/kosong/src/index.ts', '@moonshot-ai/kosong');

  _aliases = {
    // Curated host API surface for extensions (ExtensionAPI types + helpers).
    '@moonshot-ai/agent-core/extension': extensionHostApi,
    '@moonshot-ai/agent-core': agentCoreEntry,
    '@moonshot-ai/protocol': protocolEntry,
    '@moonshot-ai/kosong': kosongEntry,
  };

  return _aliases;
}

// ----------------------------------------------------------------------------
// Module loading
// ----------------------------------------------------------------------------

async function loadExtensionModule(extensionPath: string): Promise<ExtensionFactory | undefined> {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: getAliases(),
    // Extensions are TypeScript; keep interop permissive so default-exported
    // factories resolve regardless of how the author wrote the export.
    interopDefault: true,
  });

  const module = (await jiti.import(extensionPath, { default: true })) as unknown;
  const factory = module as ExtensionFactory;
  if (typeof factory !== 'function') return undefined;
  return factory;
}

// ----------------------------------------------------------------------------
// Extension construction
// ----------------------------------------------------------------------------

function isExtensionFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.mjs');
}

function deriveExtensionId(resolvedPath: string): string {
  const base = path.basename(resolvedPath).replace(/\.(ts|js|mjs)$/, '');
  // Keep it filesystem-stable and command-namespace safe.
  const sanitized = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return sanitized || 'extension';
}

function createExtension(extensionPath: string, resolvedPath: string): Extension {
  return {
    path: extensionPath,
    resolvedPath,
    id: deriveExtensionId(resolvedPath),
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
}

/**
 * Build the ExtensionAPI for one extension. Registration methods write into
 * the extension object; action methods are stubbed and replaced by the runner
 * once a session binds (see `ExtensionRunner.bind`).
 */
export function createExtensionAPI(extension: Extension): ExtensionAPIStubs {
  const api: ExtensionAPIStubs = {
    on(event, handler) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },
    registerTool(tool: ExtensionTool) {
      extension.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: Omit<RegisteredCommand, 'name'>) {
      // Store the name on the command object too, so enabledCommands() and
      // resolveCommand() can read it without re-deriving it from the Map key.
      extension.commands.set(name, { ...command, name });
    },
  };
  return api;
}

/** Internal runtime shape of a stored event handler. */
export type StoredExtensionHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

/**
 * Internal shape: registration methods only — action methods live on the
 * runtime, not the per-extension API. (Kept local so the public `ExtensionAPI`
 * in types.ts stays minimal.)
 */
export interface ExtensionAPIStubs {
  on(event: string, handler: StoredExtensionHandler): void;
  registerTool(tool: ExtensionTool): void;
  registerCommand(name: string, command: Omit<RegisteredCommand, 'name'>): void;
}

async function loadOne(
  extensionPath: string,
): Promise<{ extension: Extension | null; error: string | null }> {
  try {
    const factory = await loadExtensionModule(extensionPath);
    if (!factory) {
      return {
        extension: null,
        error: `Extension does not export a valid factory function: ${extensionPath}`,
      };
    }
    const extension = createExtension(extensionPath, extensionPath);
    const api = createExtensionAPI(extension);
    // `api` is the stubs impl; cast to the public ExtensionAPI contract the
    // factory expects (the on() overloads guarantee type safety at call sites).
    await factory(api as unknown as ExtensionAPI);
    return { extension, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { extension: null, error: `Failed to load extension: ${message}` };
  }
}

/**
 * Load a batch of already-resolved extension paths. Returns successfully
 * loaded extensions plus per-path error records (failures do not abort siblings).
 */
export async function loadExtensions(paths: readonly string[]): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const extPath of paths) {
    const { extension, error } = await loadOne(extPath);
    if (error) {
      errors.push({ path: extPath, error });
      continue;
    }
    if (extension) extensions.push(extension);
  }
  return { extensions, errors };
}

// ----------------------------------------------------------------------------
// Directory discovery
// ----------------------------------------------------------------------------

function readKimiManifest(packageJsonPath: string): KimiManifest | null {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as { kimi?: unknown };
    if (pkg.kimi && typeof pkg.kimi === 'object') return pkg.kimi as KimiManifest;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. `package.json` with a `kimi.extensions` field → returns declared paths.
 * 2. `index.ts` / `index.js` → returns the index file.
 *
 * Returns null when no entry points are found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = path.join(dir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const manifest = readKimiManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries: string[] = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = path.resolve(dir, extPath);
        if (fs.existsSync(resolvedExtPath)) entries.push(resolvedExtPath);
      }
      if (entries.length > 0) return entries;
    }
  }

  for (const indexName of ['index.ts', 'index.js', 'index.mjs']) {
    const indexPath = path.join(dir, indexName);
    if (fs.existsSync(indexPath)) return [indexPath];
  }
  return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules (one level deep, matching pi):
 * 1. Direct `*.ts`/`*.js`/`*.mjs` files.
 * 2. Subdirectory with an `index.*` or a `package.json` declaring `kimi.extensions`.
 */
export function discoverExtensionsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const discovered: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const entries = resolveExtensionEntries(entryPath);
        if (entries) discovered.push(...entries);
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

/**
 * Discover and load extensions from the standard locations plus any
 * explicitly configured paths.
 *
 * Load order (first wins on path dedup):
 * 1. Project-local: `<cwd>/.kimi-code/extensions/`
 * 2. Global:        `<homeDir>/extensions/`
 * 3. Explicit configured paths (file or directory).
 */
export async function discoverAndLoadExtensions(
  configuredPaths: readonly string[],
  cwd: string,
  homeDir: string,
): Promise<LoadExtensionsResult> {
  const allPaths: string[] = [];
  const seen = new Set<string>();

  const addPaths = (paths: readonly string[]) => {
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        allPaths.push(p);
      }
    }
  };

  // 1. Project-local extensions.
  addPaths(discoverExtensionsInDir(path.join(cwd, CONFIG_DIR_NAME, 'extensions')));
  // 2. Global extensions.
  addPaths(discoverExtensionsInDir(path.join(homeDir, 'extensions')));
  // 3. Explicit configured paths.
  for (const p of configuredPaths) {
    const resolved = path.resolve(cwd, p);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const entries = resolveExtensionEntries(resolved);
      if (entries) {
        addPaths(entries);
        continue;
      }
      addPaths(discoverExtensionsInDir(resolved));
      continue;
    }
    addPaths([resolved]);
  }

  return loadExtensions(allPaths);
}
