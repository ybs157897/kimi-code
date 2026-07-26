import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverDirectoryExperts } from '../../src/expert-team/discovery';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-expert-discovery-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTeamPackage(
  root: string,
  dirName: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const packageDir = join(root, dirName);
  await mkdir(join(packageDir, 'agents'), { recursive: true });
  const manifest = {
    name: dirName,
    version: '1.0.0',
    description: `${dirName} description`,
    expertType: 'team',
    agentName: 'lead',
    teamInfo: { leadAgent: 'lead', memberAgents: ['helper'] },
    members: [
      { agent: 'lead', role: 'lead' },
      { agent: 'helper', role: 'member' },
    ],
    ...overrides,
  };
  await writeFile(join(packageDir, 'kimi.plugin.json'), JSON.stringify(manifest));
  await writeFile(
    join(packageDir, 'agents', 'lead.md'),
    '---\nname: lead\ndescription: Lead\n---\nLead prompt.\n',
  );
  await writeFile(
    join(packageDir, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: Helper\n---\nHelper prompt.\n',
  );
  return packageDir;
}

describe('discoverDirectoryExperts', () => {
  it('discovers drop-in team packages with plugin-equivalent fields', async () => {
    const root = await makeTempDir();
    const packageDir = await writeTeamPackage(root, 'alpha-team');

    const result = await discoverDirectoryExperts([root]);

    expect(result.issues).toEqual([]);
    expect(result.experts).toHaveLength(1);
    expect(result.experts[0]).toMatchObject({
      type: 'team',
      pluginId: 'alpha-team',
      pluginRoot: packageDir,
      pluginVersion: '1.0.0',
      displayName: 'alpha-team',
      description: 'alpha-team description',
      agentName: 'lead',
      teamInfo: { leadAgent: 'lead', memberAgents: ['helper'] },
    });
    expect(result.experts[0]?.agents).toHaveLength(2);
  });

  it('skips plain directories silently and reports broken packages', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, 'notes'));
    await writeFile(join(root, 'README.md'), 'not a package');
    const brokenDir = join(root, 'broken-team');
    await mkdir(brokenDir);
    await writeFile(join(brokenDir, 'kimi.plugin.json'), '{ not json');
    // An experts/ package whose manifest forgets expertType is an authoring
    // mistake worth surfacing, not silently ignoring.
    const notExpertDir = join(root, 'not-expert');
    await mkdir(notExpertDir);
    await writeFile(join(notExpertDir, 'kimi.plugin.json'), JSON.stringify({ name: 'not-expert' }));

    const result = await discoverDirectoryExperts([root]);

    expect(result.experts).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.dir).toSorted()).toEqual([
      brokenDir,
      notExpertDir,
    ]);
  });

  it('reports team packages with invalid topology instead of loading them', async () => {
    const root = await makeTempDir();
    await writeTeamPackage(root, 'bad-team', { members: undefined });

    const result = await discoverDirectoryExperts([root]);

    expect(result.experts).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain('"members" is required');
  });

  it('lets earlier roots shadow later roots on plugin id collisions', async () => {
    const projectRoot = await makeTempDir();
    const userRoot = await makeTempDir();
    const projectDir = await writeTeamPackage(projectRoot, 'alpha-team', {
      description: 'project copy',
    });
    await writeTeamPackage(userRoot, 'alpha-team', { description: 'user copy' });
    await writeTeamPackage(userRoot, 'beta-team');

    const result = await discoverDirectoryExperts([projectRoot, userRoot]);

    expect(result.experts.map((expert) => expert.pluginId)).toEqual([
      'alpha-team',
      'beta-team',
    ]);
    expect(result.experts[0]?.pluginRoot).toBe(projectDir);
    expect(result.experts[0]?.description).toBe('project copy');
  });

  it('ignores missing roots', async () => {
    const root = await makeTempDir();
    const result = await discoverDirectoryExperts([join(root, 'does-not-exist')]);
    expect(result.experts).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});
