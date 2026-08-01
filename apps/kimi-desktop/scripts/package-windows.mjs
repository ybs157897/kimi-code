// Finalize the Windows Wails build and produce the portable ZIP.
//
// Wails' `-nsis` build drops an NSIS installer next to the main executable in
// build/bin. This script zips the portable app (exe + README.txt) and prints
// the final artifact manifest. The ZIP is written with the system `zip` tool
// (shipped with Git for Windows on the CI runner), falling back to bsdtar's
// `-a` flag — built into Windows 10+ — which produces the same ZIP format.

import { readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('package-windows: skipped (not win32)');
  process.exit(0);
}

const appRoot = resolve(import.meta.dirname, '..');
const binDir = join(appRoot, 'build', 'bin');
const exeName = 'Kimi Code.exe';
const exePath = join(binDir, exeName);
const zipName = 'Kimi-Desktop-Windows-x64.zip';
const zipPath = join(binDir, zipName);
const readmeName = 'README.txt';
const readmePath = join(binDir, readmeName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: binDir,
    stdio: options.quiet ? 'pipe' : 'inherit',
  });
  if (result.error !== undefined && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.quiet ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} exited with ${result.status}${detail}`);
  }
  return result.status === 0;
}

if (!existsSync(exePath)) {
  console.error(`package-windows: ${exePath} not found — run \`wails build -nsis\` first.`);
  process.exit(1);
}

// Wails names the NSIS output `Kimi Code-<arch>-installer.exe` (for example
// `Kimi Code-amd64-installer.exe`); collect whatever installer exists rather
// than hard-coding the arch suffix.
const installerNames = (await readdir(binDir)).filter((name) => name.endsWith('-installer.exe'));

await writeFile(
  readmePath,
  [
    'Kimi Code 桌面版',
    '',
    '双击 “Kimi Code.exe” 即可运行，无需安装。',
    '数据目录位于 %USERPROFILE%\\.kimi-desktop（会话、配置、日志等均保存在该目录）。',
    '首次启动会自动写入默认的专家团配置。',
    '',
  ].join('\r\n'),
);

try {
  // Drop any stale zip first so the packer never has to skip itself.
  await rm(zipPath, { force: true });
  // Prefer `zip` (shipped with Git for Windows on the CI runner); fall back
  // to bsdtar `-a`, which writes the same ZIP format on Windows 10+.
  if (
    !run('zip', ['-q', zipName, exeName, readmeName], { allowFailure: true, quiet: true })
  ) {
    run('tar', ['-a', '-c', '-f', zipName, exeName, readmeName]);
  }
  run('tar', ['-tf', zipName], { quiet: true });
} finally {
  await rm(readmePath, { force: true });
}

console.log(`package-windows: wrote ${zipPath}`);
for (const name of [zipName, exeName, ...installerNames]) {
  console.log(`package-windows: artifact ${join(binDir, name)}`);
}
