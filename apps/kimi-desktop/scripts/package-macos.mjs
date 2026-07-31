// Finalize the local macOS Wails bundle and produce the test ZIP.
//
// Wails' default linker ad-hoc signature covers the Mach-O but not the app
// bundle resources. Preserve any already-valid (for example Developer ID)
// bundle signature; otherwise replace the incomplete linker signature with a
// complete local ad-hoc signature before archiving.

import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('package-macos: skipped (not macOS)');
  process.exit(0);
}

const appRoot = resolve(import.meta.dirname, '..');
const binDir = join(appRoot, 'build', 'bin');
const appPath = join(binDir, 'kimi-desktop.app');
const zipPath = join(binDir, 'Kimi-Desktop-macOS-arm64-no-login.zip');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.quiet ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} exited with ${result.status}${detail}`);
  }
  return result.status === 0;
}

if (
  !run('codesign', ['--verify', '--deep', '--strict', appPath], {
    allowFailure: true,
    quiet: true,
  })
) {
  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
}
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

const tempDir = await mkdtemp(join(binDir, '.mac-package-'));
const tempZip = join(tempDir, 'Kimi-Desktop-macOS-arm64-no-login.zip');
try {
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, tempZip]);
  run('unzip', ['-tq', tempZip]);
  await rename(tempZip, zipPath);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log(`package-macos: wrote ${zipPath}`);
