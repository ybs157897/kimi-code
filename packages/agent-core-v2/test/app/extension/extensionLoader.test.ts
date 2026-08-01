/**
 * `extension` domain — App loader discovery and evaluation scenarios.
 *
 * Resolves the loader by interface with real local filesystem access and
 * verifies project/global discovery, both host API aliases, and sibling
 * failure isolation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IExtensionLoaderService } from '#/app/extension/extensionLoader';
import { ExtensionLoaderService } from '#/app/extension/extensionLoaderService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

import { stubBootstrap } from '../bootstrap/stubs';

describe('ExtensionLoaderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;
  let cwd: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(path.join(tmpdir(), 'kimi-extension-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'kimi-extension-workspace-'));
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
        reg.define(IHostFileSystem, HostFileSystem);
        reg.define(IExtensionLoaderService, ExtensionLoaderService);
      },
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  });

  it('loads project and global extensions through the legacy and v2 host aliases', async () => {
    const projectDir = path.join(cwd, '.kimi-code', 'extensions');
    const globalDir = path.join(homeDir, 'extensions');
    const legacyHostApi = ['@moonshot-ai', 'agent-core', 'extension'].join('/');
    await mkdir(projectDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'project.ts'),
      [
        `import type { ExtensionAPI } from '${legacyHostApi}';`,
        'export default (api: ExtensionAPI) => {',
        "  api.registerTool({ name: 'echo', description: 'echo', parameters: {}, execute: () => ({ output: 'ok' }) });",
        '};',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(globalDir, 'global.ts'),
      [
        "import type { ExtensionAPI } from '@moonshot-ai/agent-core-v2/extension';",
        'export default (api: ExtensionAPI) => {',
        "  api.registerCommand('hello', { description: 'hello', prompt: (args) => `hello ${args}` });",
        '};',
      ].join('\n'),
      'utf8',
    );

    const result = await ix.get(IExtensionLoaderService).load({ cwd });

    expect(result.errors).toEqual([]);
    expect(result.extensions.map((extension) => extension.id)).toEqual(['project', 'global']);
    expect(result.extensions[0]?.tools.has('echo')).toBe(true);
    expect(result.extensions[1]?.commands.has('hello')).toBe(true);
  });

  it('loads project extensions from the configured project config dir', async () => {
    const projectDir = path.join(cwd, '.kimi-desktop', 'extensions');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'desktop.ts'),
      "export default (api) => api.registerCommand('desktop', { description: 'desktop' });",
      'utf8',
    );

    const desktopIx = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir, {}, '.kimi-desktop'));
        reg.define(IHostFileSystem, HostFileSystem);
        reg.define(IExtensionLoaderService, ExtensionLoaderService);
      },
    });

    const result = await desktopIx.get(IExtensionLoaderService).load({ cwd });

    expect(result.errors).toEqual([]);
    expect(result.extensions.map((extension) => extension.id)).toEqual(['desktop']);
  });

  it('keeps a valid sibling active when another extension fails to load', async () => {
    const projectDir = path.join(cwd, '.kimi-code', 'extensions');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'broken.ts'),
      "throw new Error('broken extension');",
      'utf8',
    );
    await writeFile(
      path.join(projectDir, 'working.ts'),
      "export default (api) => api.registerCommand('ok', { description: 'ok' });",
      'utf8',
    );

    const result = await ix.get(IExtensionLoaderService).load({ cwd });

    expect(result.extensions.map((extension) => extension.id)).toEqual(['working']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ error: 'broken extension' });
  });
});
