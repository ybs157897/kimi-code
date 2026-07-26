import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractZip } from '#/app/plugin/archive';

describe('plugin archive extraction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-archive-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts a zip and detects a nested plugin root', async () => {
    const source = join(dir, 'source');
    const nested = join(source, 'plugin');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-demo' }), 'utf8');
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });

    const outDir = join(dir, 'out');
    const detectedRoot = await extractZip(await readFile(zipPath), outDir);

    expect(detectedRoot).toBe(join(outDir, 'plugin'));
    await expect(readFile(join(detectedRoot, 'kimi.plugin.json'), 'utf8')).resolves.toContain('zip-demo');
  });

  it('detects a nested WorkBuddy expert root', async () => {
    const source = join(dir, 'workbuddy-source');
    const nested = join(source, 'example-expert-team');
    await mkdir(join(nested, '.codebuddy-plugin'), { recursive: true });
    await writeFile(
      join(nested, '.codebuddy-plugin', 'plugin.json'),
      JSON.stringify({ name: 'example-expert-team' }),
      'utf8',
    );
    const zipPath = join(dir, 'workbuddy.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });

    const outDir = join(dir, 'workbuddy-out');
    const detectedRoot = await extractZip(await readFile(zipPath), outDir);

    expect(detectedRoot).toBe(join(outDir, 'example-expert-team'));
  });
});
