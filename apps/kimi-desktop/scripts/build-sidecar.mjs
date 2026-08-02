import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const appRoot = resolve(import.meta.dirname, '..');
const distDir = join(appRoot, 'sidecar', 'dist');
const runtimeDir = join(appRoot, 'internal', 'sidecar', 'runtime');
const bundlePath = join(distDir, 'engine.cjs');
const blobPath = join(distDir, 'engine.blob');
const seaConfigPath = join(distDir, 'sea-config.json');
const executableName = process.platform === 'win32' ? 'kimi-desktop-engine.exe' : 'kimi-desktop-engine';
const executablePath = join(runtimeDir, executableName);
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function requireNode24() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(`building kimi-desktop requires Node >=24.15.0, got ${process.versions.node}`);
  }
}

async function run(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    cwd: appRoot,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function assertNoUnresolvedImports(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (output.includes('[UNRESOLVED_IMPORT]')) {
    throw new Error(
      'sidecar bundle contains unresolved imports; build its workspace dependencies first',
    );
  }
}

async function main() {
  requireNode24();

  const tsdownPackage = require.resolve('tsdown/package.json');
  const tsdownRun = resolve(dirname(tsdownPackage), 'dist/run.mjs');
  const bundleResult = await run(process.execPath, [
    tsdownRun,
    '--config',
    join(appRoot, 'tsdown.sidecar.config.ts'),
  ]);
  assertNoUnresolvedImports(bundleResult);

  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
        // Chunks that must exist as REAL files at runtime inside the
        // single-file SEA: the extension host API (jiti's alias target) and
        // jiti's self-contained babel transform. The sidecar materializes both
        // next to the home dir at startup.
        assets: {
          extensionHostApi: join(distDir, 'extension-host.cjs'),
          jitiBabel: join(distDir, 'jiti-babel.cjs'),
        },
      },
      null,
      2,
    )}\n`,
  );
  await run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await copyFile(process.execPath, executablePath);
  await chmod(executablePath, 0o755);

  if (process.platform === 'darwin') {
    await run('codesign', ['--remove-signature', executablePath]).catch(() => {});
  }

  const postjectEntry = require.resolve('postject');
  const postjectCli = join(dirname(postjectEntry), 'cli.js');
  const postjectArgs = [
    postjectCli,
    executablePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    seaFuse,
  ];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  await run(process.execPath, postjectArgs);

  if (process.platform === 'darwin') {
    await run('codesign', ['--sign', '-', executablePath]);
  }
  process.stdout.write(`embedded desktop engine: ${basename(executablePath)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
