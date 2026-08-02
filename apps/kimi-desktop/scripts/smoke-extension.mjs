// Packaged-SEA extension smoke test.
//
// Verifies that the built desktop engine executable can discover, reload,
// list and activate a minimal code extension end-to-end over a real NDJSON IPC
// socket, with the extension host API materialized from the embedded SEA
// asset (the single-file runtime has no node_modules to resolve).
//
// Run AFTER `pnpm --filter @moonshot-ai/kimi-desktop build:sidecar`:
//
//   node scripts/smoke-extension.mjs
//
// Exit code 0 = the packaged extension pipeline works; any assertion failure
// prints the offending payload and exits non-zero.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const appRoot = resolve(import.meta.dirname, '..');
const executablePath = join(
  appRoot,
  'internal',
  'sidecar',
  'runtime',
  process.platform === 'win32' ? 'kimi-desktop-engine.exe' : 'kimi-desktop-engine',
);
const TOKEN = 'smoke-token';

// ---------------------------------------------------------------------------
// Minimal NDJSON IPC client (mirrors the klient-ipc frame protocol).
// ---------------------------------------------------------------------------

class IpcClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    if (this.endpoint.startsWith('tcp://')) {
      const url = new URL(this.endpoint);
      this.socket = connect({ host: url.hostname, port: Number(url.port) });
    } else {
      this.socket = connect(this.endpoint);
    }
    this.socket.setEncoding('utf8');
    this.rl = createInterface({ input: this.socket, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.type === 'result' || frame.type === 'error') {
        const waiter = this.pending.get(frame.id);
        if (waiter === undefined) return;
        this.pending.delete(frame.id);
        if (frame.type === 'error') waiter.reject(new Error(`rpc ${frame.code}: ${frame.msg}`));
        else waiter.resolve(frame.data);
      }
    });
    await once(this.socket, 'connect');
  }

  send(frame) {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  hello(token) {
    this.send({ type: 'hello', token });
  }

  call(service, method, arg, scope = 'core') {
    const id = `c${++this.nextId}`;
    const promise = new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    });
    this.send({ type: 'call', id, scope, service, method, arg });
    return promise;
  }

  close() {
    this.rl?.close();
    this.socket?.destroy();
  }
}

function fail(message) {
  console.error(`smoke-extension FAILED: ${message}`);
  process.exitCode = 1;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** DesktopProduct calls answer with the kimi-web WireEnvelope ({code, msg,
 *  data, request_id}); the raw klient services answer bare results. Unwrap the
 *  envelope (checking the code) so both surfaces read uniformly. */
function unwrapEnvelope(result, label) {
  if (result && typeof result === 'object' && 'code' in result && 'data' in result) {
    if (result.code !== 0) {
      throw new Error(`${label} failed (${result.code}): ${result.msg}`);
    }
    return result.data;
  }
  return result;
}

async function main() {
  try {
    await access(executablePath);
  } catch {
    fail(`built engine not found at ${executablePath} — run build:sidecar first`);
    return;
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), 'kimi-desktop-smoke-'));
  const home = join(tmpRoot, 'home');
  const requestedEndpoint =
    process.platform === 'win32' ? 'tcp://127.0.0.1:0' : join(tmpRoot, 'ipc.sock');
  const workDir = join(tmpRoot, 'work');
  const extensionsDir = join(workDir, '.kimi-desktop', 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const fixturePath = join(extensionsDir, 'demo.ts');
  await writeFile(
    fixturePath,
    [
      '// Minimal packaged-extension fixture: imports the host API (type-only —',
      "// the facade exports only contracts today) and registers one command.",
      "import type { ExtensionAPI } from '@moonshot-ai/agent-core-v2/extension';",
      '',
      'export default function demoExtension(api: ExtensionAPI): void {',
      "  api.registerCommand('demo-greet', {",
      "    description: 'Smoke-test command',",
      "    prompt: () => 'hello from the packaged extension',",
      '  });',
      '}',
      '',
    ].join('\n'),
  );

  const child = spawn(executablePath, [], {
    env: {
      ...process.env,
      KIMI_DESKTOP_HOME: home,
      KIMI_DESKTOP_IPC_ENDPOINT: requestedEndpoint,
      KIMI_DESKTOP_IPC_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sidecarOutput = '';
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    const onLine = (line) => {
      sidecarOutput += `${line}\n`;
      const marker = 'desktop-sidecar ready ';
      const markerIndex = line.indexOf(marker);
      if (markerIndex >= 0) resolveReady(line.slice(markerIndex + marker.length).trim());
    };
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line) onLine(line);
      }
    });
    child.once('exit', (code) => rejectReady(new Error(`sidecar exited early (${code})`)));
  });

  let client;
  try {
    const endpoint = await withTimeout(readyPromise, 30_000, 'sidecar ready timeout');
    client = new IpcClient(endpoint);
    await client.connect();
    client.hello(TOKEN);

    // The extension host API asset must have been materialized next to the
    // home dir — this is the file the jiti alias points at inside the SEA.
    const hostApiPath = join(home, 'extension-host.cjs');
    await access(hostApiPath).catch(() => {
      fail(`extension host API was not materialized at ${hostApiPath}`);
      throw new Error('missing host api');
    });

    const handle = await client.call('sessionLifecycleService', 'create', [{ workDir }]);
    const sessionId = handle?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`session create returned no id: ${JSON.stringify(handle)}`);
    }

    const reload = unwrapEnvelope(
      await client.call('desktopProduct', 'reloadExtensions', [sessionId]),
      'reloadExtensions',
    );
    if (Array.isArray(reload?.errors) && reload.errors.length > 0) {
      throw new Error(`reloadExtensions reported errors: ${JSON.stringify(reload.errors)}`);
    }
    const active = reload?.active ?? [];
    if (!active.some((path) => String(path).includes('demo.ts'))) {
      throw new Error(`fixture extension not active: ${JSON.stringify(active)}`);
    }

    const listed = unwrapEnvelope(
      await client.call('desktopProduct', 'listExtensionCommands', [sessionId]),
      'listExtensionCommands',
    );
    const commands = listed?.commands ?? [];
    if (!commands.some((c) => c?.name === 'demo-greet')) {
      throw new Error(`demo-greet command missing: ${JSON.stringify(commands)}`);
    }

    const activated = unwrapEnvelope(
      await client.call('desktopProduct', 'activateExtensionCommand', [
        sessionId,
        { extension_id: 'demo', name: 'demo-greet', args: '' },
      ]),
      'activateExtensionCommand',
    );
    if (activated?.activated !== true) {
      throw new Error(`activateExtensionCommand failed: ${JSON.stringify(activated)}`);
    }

    console.log('smoke-extension OK: reload → list → activate over packaged SEA IPC');
    console.log(`  fixture:        ${fixturePath}`);
    console.log(`  host API file:  ${hostApiPath}`);
    console.log(`  active:         ${active.join(', ')}`);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n--- sidecar output ---\n${sidecarOutput}`);
  } finally {
    client?.close();
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
