// Bundle the repository's default experts tree into the packaged build.
//
// `wails build -tags packaged` embeds internal/appdata/experts.tar.gz via
// go:embed; on first start the application materializes it into the desktop
// home directory. The archive keeps `experts/` as its top-level directory so
// the Go extractor (internal/appdata/bundled_experts.go) can validate every
// member against that prefix. Idempotent: re-running overwrites the target.

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '..', '..');
const targetDir = join(appRoot, 'internal', 'appdata');
const targetPath = join(targetDir, 'experts.tar.gz');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
}

await mkdir(targetDir, { recursive: true });
// Run in the repo root and use -C to strip the `.kimi-desktop` wrapper, so
// the archive's top-level entry is exactly `experts/` — the prefix the Go
// extractor validates. System `tar` (bsdtar) is available on macOS, Linux,
// and the Windows GitHub runners.
run('tar', ['-czf', targetPath, '-C', '.kimi-desktop', 'experts']);
console.log(`bundle-experts: wrote ${targetPath}`);
