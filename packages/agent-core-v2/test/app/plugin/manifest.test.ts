import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseManifest } from '#/app/plugin/manifest';

describe('plugin manifest parser', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-manifest-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads recursive command entries and valid hooks', async () => {
    await mkdir(join(dir, 'commands', 'frontend'), { recursive: true });
    await writeFile(join(dir, 'commands', 'frontend', 'component.md'), '# Component', 'utf8');
    await writeFile(join(dir, 'commands', 'deploy.md'), '# Deploy', 'utf8');
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        commands: ['./commands'],
        hooks: [{ event: 'Stop', command: 'echo stop' }],
      }),
      'utf8',
    );

    const result = await parseManifest(dir);
    const root = await realpath(dir);

    expect(result.manifest?.commands).toEqual([
      { path: join(root, 'commands', 'deploy.md'), name: 'deploy' },
      { path: join(root, 'commands', 'frontend', 'component.md'), name: 'frontend/component' },
    ]);
    expect(result.manifest?.hooks).toEqual([{ event: 'Stop', command: 'echo stop' }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('warns on invalid hooks and command paths', async () => {
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        commands: ['../outside.md'],
        hooks: [{ event: 'Nope', command: 'echo nope' }],
      }),
      'utf8',
    );

    const result = await parseManifest(dir);

    expect(result.manifest?.commands).toBeUndefined();
    expect(result.manifest?.hooks).toBeUndefined();
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('Invalid hook at index 0'),
      '"commands" path must start with "./" (got "../outside.md")',
    ]);
  });

  it('reads a WorkBuddy-compatible expert-team manifest', async () => {
    await mkdir(join(dir, '.codebuddy-plugin'), { recursive: true });
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'delivery-lead.md'), '# Lead', 'utf8');
    await writeFile(join(dir, 'agents', 'architect.md'), '# Architect', 'utf8');
    await writeFile(
      join(dir, '.codebuddy-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'delivery-experts',
        version: '1.0.0',
        displayName: 'Delivery Experts',
        displayDescription: 'A lead and specialist for delivery planning.',
        profession: 'Delivery Experts',
        expertType: 'team',
        agentName: 'delivery-lead',
        teamInfo: {
          leadAgent: 'delivery-lead',
          memberAgents: ['architect'],
        },
        members: [
          {
            id: 'delivery-lead',
            role: 'lead',
            name: { en: 'Lead', zh: '主理人' },
            profession: { en: 'Delivery lead', zh: '交付负责人' },
          },
          {
            id: 'architect',
            role: 'member',
            name: { en: 'Architect', zh: '架构师' },
            profession: { en: 'Software architect', zh: '软件架构师' },
          },
        ],
        tags: ['delivery', 'architecture', 'planning'],
        quickPrompts: ['Plan this delivery', 'Review architecture', 'Assess risk'],
        defaultInitPrompt: 'Plan this delivery',
        categoryId: '02-Engineering',
      }),
      'utf8',
    );

    const result = await parseManifest(dir);
    const root = await realpath(dir);

    expect(result.manifestKind).toBe('codebuddy-plugin-dir');
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.interface).toEqual({
      displayName: 'Delivery Experts',
      shortDescription: 'A lead and specialist for delivery planning.',
      longDescription: undefined,
      developerName: undefined,
      websiteURL: undefined,
    });
    expect(result.manifest?.expert).toEqual({
      type: 'team',
      agentName: 'delivery-lead',
      agents: [
        join(root, 'agents', 'architect.md'),
        join(root, 'agents', 'delivery-lead.md'),
      ],
      teamInfo: {
        leadAgent: 'delivery-lead',
        memberAgents: ['architect'],
      },
      members: [
        {
          agent: 'delivery-lead',
          role: 'lead',
          displayName: undefined,
          name: { en: 'Lead', zh: '主理人' },
          profession: { en: 'Delivery lead', zh: '交付负责人' },
          description: undefined,
          avatar: undefined,
        },
        {
          agent: 'architect',
          role: 'member',
          displayName: undefined,
          name: { en: 'Architect', zh: '架构师' },
          profession: { en: 'Software architect', zh: '软件架构师' },
          description: undefined,
          avatar: undefined,
        },
      ],
      profession: 'Delivery Experts',
      displayDescription: 'A lead and specialist for delivery planning.',
      tags: ['delivery', 'architecture', 'planning'],
      quickPrompts: ['Plan this delivery', 'Review architecture', 'Assess risk'],
      defaultInitPrompt: 'Plan this delivery',
      categoryId: '02-Engineering',
    });
  });

  it('rejects an invalid expert-team topology', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'lead.md'), '# Lead', 'utf8');
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'broken-team',
        expertType: 'team',
        agentName: 'lead',
        agents: ['./agents/lead.md'],
        teamInfo: { leadAgent: 'other', memberAgents: ['missing'] },
        members: [{ agent: 'lead', role: 'member' }],
      }),
      'utf8',
    );

    const result = await parseManifest(dir);

    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        '"teamInfo.leadAgent" must equal "agentName"',
        '"teamInfo.memberAgents" references undeclared agent "missing"',
        '"members" must contain exactly one lead matching "teamInfo.leadAgent"',
      ]),
    );
  });
});
