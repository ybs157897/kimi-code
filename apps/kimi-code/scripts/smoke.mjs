import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(appRoot, 'dist', 'main.mjs');
const webIndexPath = resolve(appRoot, 'dist-web', 'index.html');
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

function fail(message) {
  throw new Error(message);
}

async function ensureBundleExists() {
  try {
    await stat(bundlePath);
  } catch {
    fail(`Bundle not found at ${bundlePath}. Run \`pnpm build\` first.`);
  }
}

async function ensureRuntimeAssetsExist() {
  try {
    await stat(webIndexPath);
  } catch {
    fail(`Runtime asset not found at ${webIndexPath}. Run \`pnpm build\` first.`);
  }
}

async function runBundle(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath, ...args], {
      cwd: options.cwd ?? appRoot,
      env: options.env,
      maxBuffer: 1024 * 1024 * 16,
      timeout: 30_000,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Bundle smoke failed: node ${bundlePath} ${args.join(' ')}\n${detail}`);
  }
}

async function startFakeProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
      });

      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found', type: 'not_found' } }));
        return;
      }

      const base = {
        id: 'chatcmpl-cli-smoke',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'stub-model',
      };
      const events = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'v2 print smoke ok' },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
        },
      ];
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      response.end(`${body}data: [DONE]\n\n`);
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    fail('Fake provider did not bind a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      }),
  };
}

async function runRuntimeSmokes() {
  const root = await mkdtemp(join(tmpdir(), 'kimi-cli-bundle-smoke-'));
  const homeDir = join(root, 'kimi-home');
  const osHomeDir = join(root, 'os-home');
  const workDir = join(root, 'workspace');
  const provider = await startFakeProvider();

  try {
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      mkdir(osHomeDir, { recursive: true }),
      mkdir(workDir, { recursive: true }),
    ]);
    await writeFile(
      join(homeDir, 'config.toml'),
      `default_model = "smoke-model"

[providers.smoke]
type = "openai"
base_url = "${provider.baseUrl}"
api_key = "YOUR_API_KEY"

[models.smoke-model]
provider = "smoke"
model = "stub-model"
max_context_size = 128000
`,
      'utf8',
    );
    const env = {
      ...process.env,
      HOME: osHomeDir,
      USERPROFILE: osHomeDir,
      KIMI_CODE_HOME: homeDir,
      KIMI_DISABLE_TELEMETRY: '1',
    };

    const printOutput = await runBundle(
      ['--prompt', 'Reply exactly: v2 print smoke ok', '--model', 'smoke-model'],
      { cwd: workDir, env },
    );
    assertIncludes(printOutput, 'v2 print smoke ok', '--prompt');
    if (
      provider.requests.length !== 1 ||
      provider.requests[0]?.url !== '/v1/chat/completions'
    ) {
      fail(
        `Print smoke did not make exactly one chat-completions request: ${JSON.stringify(provider.requests)}`,
      );
    }

    const shellOutput = await runBundle(['migrate'], { cwd: workDir, env });
    assertIncludes(shellOutput, 'Nothing to migrate', 'migrate');

    await runAcpInitializeSmoke({ cwd: workDir, env });
  } finally {
    try {
      await provider.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function runAcpInitializeSmoke(options) {
  const child = spawn(process.execPath, [bundlePath, 'acp'], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const childExit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      resolveExit({ code, signal });
    });
  });

  try {
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        rejectResponse(
          new Error(`ACP initialize timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
      }, 15_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectResponse(error);
      });
      child.once('exit', (code, signal) => {
        if (stdout.split('\n').some((line) => line.trim().length > 0)) return;
        clearTimeout(timer);
        rejectResponse(
          new Error(`ACP exited before initialize: code=${code} signal=${signal}\nstderr:\n${stderr}`),
        );
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id !== 1) continue;
          clearTimeout(timer);
          resolveResponse(message);
          return;
        }
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
          },
        })}\n`,
      );
    });

    if (response.error !== undefined) {
      fail(`ACP initialize returned an error: ${JSON.stringify(response.error)}`);
    }
    if (response.result?.protocolVersion !== 1) {
      fail(`ACP initialize returned an unexpected protocol version: ${JSON.stringify(response)}`);
    }
    if (response.result?.agentCapabilities?.mcpCapabilities?.http !== true) {
      fail(`ACP initialize did not advertise HTTP MCP support: ${JSON.stringify(response)}`);
    }
  } finally {
    child.stdin.end();
    const exit = await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectExit(new Error(`ACP did not exit after stdin closed.\nstderr:\n${stderr}`));
      }, 15_000);
      childExit.then(
        (result) => {
          clearTimeout(timer);
          resolveExit(result);
        },
        (error) => {
          clearTimeout(timer);
          rejectExit(error);
        },
      );
    });
    if (exit.code !== 0) {
      fail(`ACP smoke exited with code=${exit.code} signal=${exit.signal}.\nstderr:\n${stderr}`);
    }
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Bundle smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

async function main() {
  await ensureBundleExists();
  await ensureRuntimeAssetsExist();

  const versionOutput = await runBundle(['--version']);
  assertIncludes(versionOutput, expectedVersion, '--version');

  const helpOutput = await runBundle(['--help']);
  assertIncludes(helpOutput, 'Usage: kimi', '--help');

  const exportHelpOutput = await runBundle(['export', '--help']);
  assertIncludes(exportHelpOutput, 'Usage: kimi export', 'export --help');

  const webHelpOutput = await runBundle(['web', '--help']);
  assertIncludes(webHelpOutput, 'Usage: kimi web', 'web --help');

  await runRuntimeSmokes();
  console.log(`Bundle smoke passed: ${bundlePath}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
