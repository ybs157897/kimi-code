/**
 * Desktop engine host ("sidecar").
 *
 * Boots the agent-core-v2 engine in-process and serves the full klient facade
 * over a unix domain socket using the klient-ipc protocol. The Go/Wails shell
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
import { dirname, join } from 'node:path';

import {
  agentCatalogRuntimeOptionsSeed,
  bootstrap,
  hostRequestHeadersSeed,
  IConfigService,
  logSeed,
  resolveKimiHome,
  resolveLoggingConfig,
  skillCatalogRuntimeOptionsSeed,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { serveProductIpc, type ProductIpcHost } from './product/host.js';

/** Env var carrying the unix socket path to listen on (contract D). */
const SOCKET_ENV = 'KIMI_DESKTOP_IPC_SOCKET';
/** Env var carrying the shared hello token (contract D). */
const TOKEN_ENV = 'KIMI_DESKTOP_IPC_TOKEN';

function resolveSocketPath(kimiHome: string): string {
  const fromEnv = process.env[SOCKET_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(kimiHome, 'desktop', 'sidecar.sock');
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
  const kimiHome = resolveKimiHome();
  const socketPath = resolveSocketPath(kimiHome);
  const token = process.env[TOKEN_ENV] || undefined;

  // The host removes a stale socket file itself, but the parent directory must
  // already exist for `listen` to succeed.
  await mkdir(dirname(socketPath), { recursive: true });

  const logging = resolveLoggingConfig({ homeDir: kimiHome, env: process.env });
  const { app } = bootstrap({ homeDir: kimiHome }, [
    ...logSeed(logging),
    ...hostRequestHeadersSeed({}),
    ...skillCatalogRuntimeOptionsSeed(undefined),
    ...agentCatalogRuntimeOptionsSeed(undefined),
  ]);

  try {
    await app.accessor.get(IConfigService).ready;
    const host = await serveProductIpc({ scope: app, socketPath, token });
    // Stable readiness line the shell greps for before dialing (contract D).
    console.log(`desktop-sidecar ready ${socketPath}`);
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
