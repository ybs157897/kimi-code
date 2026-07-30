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

import { mkdir } from 'node:fs/promises';
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

/** Env var carrying the local IPC endpoint to listen on (contract D). */
const ENDPOINT_ENV = 'KIMI_DESKTOP_IPC_ENDPOINT';
/** Env var carrying the shared hello token (contract D). */
const TOKEN_ENV = 'KIMI_DESKTOP_IPC_TOKEN';
/** Desktop-only home override. KIMI_CODE_HOME is intentionally ignored. */
const HOME_ENV = 'KIMI_DESKTOP_HOME';

function resolveDesktopHome(): string {
  const fromEnv = process.env[HOME_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.kimi-desktop');
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
  if (!endpoint.startsWith('tcp://')) {
    await mkdir(dirname(endpoint), { recursive: true });
  }

  const logging = resolveLoggingConfig({ homeDir: kimiHome, env: process.env });
  const { app } = bootstrap({ homeDir: kimiHome }, [
    ...logSeed(logging),
    ...hostRequestHeadersSeed({}),
    ...skillCatalogRuntimeOptionsSeed(undefined),
    ...agentCatalogRuntimeOptionsSeed(undefined),
  ]);

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
