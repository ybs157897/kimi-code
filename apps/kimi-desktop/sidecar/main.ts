/**
 * Desktop engine host ("sidecar").
 *
 * Boots the agent-core-v2 engine in-process and serves the full klient facade
 * over an authenticated local IPC endpoint using the klient-ipc protocol. The Go/Wails shell
 * spawns this process (contract D), waits for the readiness line, then dials
 * the socket and speaks the klient-ipc frame protocol (contract A) — the same
 * facade an in-memory `createKlient({ scope })` exposes, only serialized.
 *
 * Phase 1 swaps the bare `serveKlientIpc` for the product host
 * (`./product/host.ts`): every existing klient service still dispatches through
 * the shared memory dispatcher (Phase 0 stays intact), and the reserved
 * `desktopProduct` service + `product` event stream add the kimi-web product
 * projection layer (frozen contract E).
 *
 * Mirrors `packages/node-sdk/src/v2/runtime.ts`: the same `bootstrap` call and
 * seeds, but a product IPC host instead of `createKlient({ scope })`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  agentCatalogRuntimeOptionsSeed,
  bootstrap,
  hostRequestHeadersSeed,
  IConfigService,
  logSeed,
  resolveLoggingConfig,
  skillCatalogRuntimeOptionsSeed,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { serveProductIpc, type ProductIpcHost } from './product/host.js';
import {
  RUNTIME_FILE_ASSETS,
  TREE_SITTER_ASSETS_DIR,
  TREE_SITTER_ASSETS_ENV,
  TREE_SITTER_WASM_ASSETS,
} from './runtime-assets.mjs';

/** Env var carrying the local IPC endpoint to listen on (contract D). */
const ENDPOINT_ENV = 'KIMI_DESKTOP_IPC_ENDPOINT';
/** Env var carrying the shared hello token (contract D). */
const TOKEN_ENV = 'KIMI_DESKTOP_IPC_TOKEN';
/** Desktop-only home override. KIMI_CODE_HOME is intentionally ignored. */
const HOME_ENV = 'KIMI_DESKTOP_HOME';
/**
 * Project-level local config directory name inside the user's workspace,
 * keeping desktop sessions fully independent from the CLI's `.kimi-code`
 * project directory.
 */
const PROJECT_CONFIG_DIR_NAME = '.kimi-desktop';
function resolveDesktopHome(): string {
  const fromEnv = process.env[HOME_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.kimi-desktop');
}

/**
 * In a packaged SEA several modules cannot be resolved from disk (there is no
 * node_modules): the extension host API (jiti's alias target) and jiti's
 * self-contained babel transform. The build embeds them as SEA assets; this
 * materializes each next to the home dir once and points the consuming code at
 * it via env. Dev mode (tsx ESM over node_modules) skips this entirely.
 */
async function materializeSeaAssets(home: string): Promise<void> {
  let sea:
    | {
        isSea(): boolean;
        getAsset(name: string, encoding?: 'utf8'): string | ArrayBuffer;
      }
    | undefined;
  try {
    // `node:sea` exists on Node 24; guard anyway so a non-SEA runtime never
    // trips over module availability.
    sea = createRequire(import.meta.url)('node:sea') as typeof sea;
  } catch {
    return;
  }
  if (sea === undefined || !sea.isSea()) return;
  for (const { id, target: file, env } of RUNTIME_FILE_ASSETS) {
    try {
      const source = sea.getAsset(id, id.endsWith('Wasm') ? undefined : 'utf8');
      const target = join(home, file);
      try {
        await writeFile(
          target,
          typeof source === 'string' ? source : new Uint8Array(source),
          { flag: 'wx' },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (typeof source === 'string') {
          const existing = await readFile(target, 'utf8').catch(() => '');
          if (existing !== source) await writeFile(target, source);
        } else {
          await writeFile(target, new Uint8Array(source));
        }
      }
      if (env !== undefined) process.env[env] = target;
    } catch (error) {
      throw new Error(`desktop-sidecar: failed to materialize runtime asset ${id}`, {
        cause: error,
      });
    }
  }
  const grammarRoot = join(home, TREE_SITTER_ASSETS_DIR);
  for (let index = 0; index < TREE_SITTER_WASM_ASSETS.length; index += 1) {
    const wasmAsset = TREE_SITTER_WASM_ASSETS[index];
    if (wasmAsset === undefined) continue;
    const [wasmPackage, wasmFile] = wasmAsset;
    const id = `treeSitterWasm${index}`;
    const target = join(grammarRoot, wasmPackage, wasmFile);
    try {
      await mkdir(dirname(target), { recursive: true });
      const asset = sea.getAsset(id);
      await writeFile(target, typeof asset === 'string' ? asset : new Uint8Array(asset));
    } catch (error) {
      throw new Error(`desktop-sidecar: failed to materialize runtime asset ${id}`, {
        cause: error,
      });
    }
  }
  process.env[TREE_SITTER_ASSETS_ENV] = grammarRoot;
}

function resolveEndpoint(): string {
  const fromEnv = process.env[ENDPOINT_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return 'tcp://127.0.0.1:0';
}

function installShutdownHandlers(host: ProductIpcHost, app: Scope): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await host.close();
    } finally {
      app.dispose();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

async function main(): Promise<void> {
  const kimiHome = resolveDesktopHome();
  const endpoint = resolveEndpoint();
  const token = process.env[TOKEN_ENV] || undefined;

  // Force any legacy engine-level home resolution into the desktop namespace.
  // This process-local assignment never changes the CLI's environment.
  process.env['KIMI_CODE_HOME'] = kimiHome;
  await mkdir(kimiHome, { recursive: true });
  await materializeSeaAssets(kimiHome);
  if (!endpoint.startsWith('tcp://')) {
    await mkdir(dirname(endpoint), { recursive: true });
  }

  const logging = resolveLoggingConfig({ homeDir: kimiHome, env: process.env });
  const { app } = bootstrap(
    { homeDir: kimiHome, projectConfigDirName: PROJECT_CONFIG_DIR_NAME },
    [
      ...logSeed(logging),
      ...hostRequestHeadersSeed({}),
      ...skillCatalogRuntimeOptionsSeed(undefined),
      ...agentCatalogRuntimeOptionsSeed(undefined),
    ],
  );

  try {
    await app.accessor.get(IConfigService).ready;
    const host = await serveProductIpc({ scope: app, endpoint, token });
    // Stable readiness line the shell greps for before dialing (contract D).
    console.log(`desktop-sidecar ready ${host.endpoint}`);
    installShutdownHandlers(host, app);
  } catch (error) {
    app.dispose();
    throw error;
  }
}

main().catch((error) => {
  console.error('desktop-sidecar failed to start:', error);
  process.exit(1);
});
