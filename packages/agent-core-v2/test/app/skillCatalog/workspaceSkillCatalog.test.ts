/**
 * Scenario: session-less workspace skill listing.
 * Responsibilities: preserve Session-catalog source priority and explicit-dir
 * replacement while returning summaries only. The real catalog service and
 * root resolution run through DI; skill discovery and plugin/config inputs are
 * the controlled boundaries.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/skillCatalog/workspaceSkillCatalog.test.ts
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  createServices,
  type TestInstantiationService,
} from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import {
  type SkillDiscoveryResult,
  ISkillDiscovery,
} from '#/app/skillCatalog/skillDiscovery';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import type { SkillRoot, SkillSource } from '#/app/skillCatalog/types';
import { IWorkspaceSkillCatalogService } from '#/app/skillCatalog/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/app/skillCatalog/workspaceSkillCatalogService';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubSkill } from './stubs';

describe('Workspace skill catalog (session-less source merge)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let rootDir: string;
  let homeDir: string;
  let osHomeDir: string;
  let workDir: string;
  let userDir: string;
  let projectDir: string;
  let extraDir: string;
  let explicitDir: string;
  let pluginDir: string;
  let explicitDirs: readonly string[] | undefined;

  beforeEach(async () => {
    disposables = new DisposableStore();
    rootDir = await mkdtemp(join(tmpdir(), 'workspace-skill-catalog-'));
    homeDir = join(rootDir, 'kimi-home');
    osHomeDir = join(rootDir, 'os-home');
    workDir = join(rootDir, 'workspace');
    userDir = join(homeDir, 'skills');
    projectDir = join(workDir, '.kimi-code', 'skills');
    extraDir = join(rootDir, 'extra');
    explicitDir = join(rootDir, 'explicit');
    pluginDir = join(rootDir, 'plugin');
    await Promise.all(
      [userDir, projectDir, extraDir, explicitDir, pluginDir, osHomeDir].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );

    const canonical = new Map(
      await Promise.all(
        [userDir, projectDir, extraDir, explicitDir, pluginDir].map(async (dir) => [
          await realpath(dir),
          dir,
        ] as const),
      ),
    );
    const discovery = {
      _serviceBrand: undefined,
      discover: async (roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> => {
        const skills = roots.flatMap((root) => {
          const kind =
            root.plugin !== undefined
              ? 'plugin'
              : sourceKind(canonical.get(root.path), {
                  userDir,
                  projectDir,
                  extraDir,
                  explicitDir,
                });
          if (kind === undefined) return [];
          const source: SkillSource = root.source;
          return [
            stubSkill(`${kind}-only`, {
              description: `${kind} only`,
              source,
              plugin: root.plugin,
              content: `${kind} private content`,
            }),
            stubSkill('collision', {
              description: `${kind} wins`,
              source,
              plugin: root.plugin,
              content: `${kind} private content`,
            }),
          ];
        });
        return {
          skills,
          skipped: [],
          scannedRoots: roots.map((root) => root.path),
        };
      },
    } satisfies ISkillDiscovery;

    const bootstrap = stubBootstrap(homeDir);
    Object.defineProperty(bootstrap, 'osHomeDir', { value: osHomeDir });
    ix = createServices(disposables, {
      additionalServices: (services) => {
        services.defineInstance(IBootstrapService, bootstrap);
        services.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: <T>(domain: string): T => {
            if (domain === EXTRA_SKILL_DIRS_SECTION) return [extraDir] as T;
            if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return true as T;
            return undefined as T;
          },
        });
        services.defineInstance(ISkillDiscovery, discovery);
        services.definePartialInstance(IBuiltinSkillSource, {
          load: async () => ({
            skills: [
              stubSkill('builtin-only', {
                source: 'builtin',
                description: 'builtin only',
                content: 'builtin private content',
              }),
              stubSkill('collision', {
                source: 'builtin',
                description: 'builtin wins',
                content: 'builtin private content',
              }),
            ],
          }),
        });
        services.definePartialInstance(IPluginService, {
          pluginSkillRoots: async () => [
            {
              path: pluginDir,
              source: 'extra',
              plugin: { id: 'example-plugin' },
            },
          ],
        });
        services.defineInstance(ISkillCatalogRuntimeOptions, {
          _serviceBrand: undefined,
          get explicitDirs() {
            return explicitDirs;
          },
        });
        services.define(IWorkspaceSkillCatalogService, WorkspaceSkillCatalogService);
      },
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('list merges every source by Session-catalog priority and returns summaries', async () => {
    const skills = await ix.get(IWorkspaceSkillCatalogService).list(workDir);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    expect(byName.get('builtin-only')).toMatchObject({ source: 'builtin' });
    expect(byName.get('plugin-only')).toMatchObject({ source: 'extra' });
    expect(byName.get('extra-only')).toMatchObject({ source: 'extra' });
    expect(byName.get('user-only')).toMatchObject({ source: 'user' });
    expect(byName.get('project-only')).toMatchObject({ source: 'project' });
    expect(byName.get('collision')).toMatchObject({
      source: 'project',
      description: 'project wins',
    });
    expect(byName.get('collision')).not.toHaveProperty('content');
    expect(byName.get('collision')).not.toHaveProperty('metadata');
  });

  it('list replaces default user and project discovery when explicit dirs are set', async () => {
    explicitDirs = [explicitDir];

    const skills = await ix.get(IWorkspaceSkillCatalogService).list(workDir);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    expect(byName.get('explicit-only')).toMatchObject({ source: 'user' });
    expect(byName.get('user-only')).toBeUndefined();
    expect(byName.get('project-only')).toBeUndefined();
    expect(byName.get('extra-only')).toBeDefined();
    expect(byName.get('plugin-only')).toBeDefined();
    expect(byName.get('builtin-only')).toBeDefined();
    expect(byName.get('collision')).toMatchObject({
      source: 'user',
      description: 'explicit wins',
    });
  });
});

function sourceKind(
  path: string | undefined,
  dirs: {
    readonly userDir: string;
    readonly projectDir: string;
    readonly extraDir: string;
    readonly explicitDir: string;
  },
): 'user' | 'project' | 'extra' | 'explicit' | undefined {
  if (path === dirs.userDir) return 'user';
  if (path === dirs.projectDir) return 'project';
  if (path === dirs.extraDir) return 'extra';
  if (path === dirs.explicitDir) return 'explicit';
  return undefined;
}
