import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { KnowledgeGraphService } from '#/session/knowledgeGraph/knowledgeGraphService';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-graph-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'auth.ts'),
    [
      "import { helper } from './util';",
      '',
      'export function login(user: string, password: string): boolean {',
      '  return helper() > 0 && user.length > 0 && password.length > 0;',
      '}',
      '',
      'export class SessionManager {',
      '  validate(token: string): boolean {',
      '    return token.length > 10;',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'src', 'util.ts'), ['export function helper(): number {', '  return 42;', '}', ''].join('\n'));
  return dir;
}

function createService(workDir: string): KnowledgeGraphService {
  const workspace = { workDir } as ISessionWorkspaceContext;
  const bootstrap = { projectConfigDirName: '.kimi-code' } as IBootstrapService;
  return new KnowledgeGraphService(workspace, bootstrap);
}

describe('KnowledgeGraphService', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = createWorkspace();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reports missing before any build', async () => {
    const service = createService(workDir);
    expect(await service.getStatus()).toEqual({ state: 'missing' });
    expect(await service.search('login')).toEqual([]);
  });

  it('builds a static graph, persists it, and searches nodes with file locations', async () => {
    const service = createService(workDir);
    const stats = await service.buildStatic();

    expect(stats.files).toBe(2);
    expect(stats.functions).toBeGreaterThanOrEqual(2);
    expect(stats.classes).toBe(1);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);

    const graph = service.getGraph();
    expect(graph).not.toBeNull();
    expect(graph!.nodes.some((n) => n.type === 'file' && n.filePath === join('src', 'auth.ts'))).toBe(true);

    const hits = await service.search('login');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe('login');
    expect(hits[0]!.filePath).toBe(join('src', 'auth.ts'));

    // Status is ready without git (no hash to compare against).
    const status = await service.getStatus();
    expect(status.state).toBe('ready');
    expect(status.stats?.files).toBe(2);
  });

  it('reloads a persisted graph in a fresh service instance', async () => {
    await createService(workDir).buildStatic();

    const reloaded = createService(workDir);
    const hits = await reloaded.search('SessionManager');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.filePath).toBe(join('src', 'auth.ts'));
  });

  it('drives the summarization loop: list pending, merge analyses, merge project summary', async () => {
    const service = createService(workDir);
    await service.buildStatic();

    expect(await service.summarizationStatus()).toEqual({
      totalFiles: 2,
      summarizedFiles: 0,
      hasProjectSummary: false,
    });

    const pending = await service.listUnsummarizedFiles();
    expect(pending.map((f) => f.filePath).sort()).toEqual([join('src', 'auth.ts'), join('src', 'util.ts')]);
    const authEntry = pending.find((f) => f.filePath === join('src', 'auth.ts'))!;
    expect(authEntry.functions).toContain('login');
    expect(authEntry.classes).toContain('SessionManager');

    const { applied } = await service.applyFileAnalyses([
      {
        filePath: join('src', 'auth.ts'),
        fileSummary: 'Authentication entry points.',
        tags: ['auth'],
        complexity: 'simple',
        functionSummaries: { login: 'Validates credentials.' },
        classSummaries: { SessionManager: 'Tracks sessions.' },
      },
    ]);
    expect(applied).toBe(1);

    expect(await service.summarizationStatus()).toEqual({
      totalFiles: 2,
      summarizedFiles: 1,
      hasProjectSummary: false,
    });

    const hits = await service.search('login');
    expect(hits[0]!.summary).toBe('Validates credentials.');

    await service.applyProjectSummary({
      description: 'Test project.',
      frameworks: ['TypeScript'],
      layers: [{ name: 'Src', description: 'Sources', filePatterns: ['src/'] }],
    });

    const status = await service.summarizationStatus();
    expect(status.hasProjectSummary).toBe(true);

    const graph = service.getGraph()!;
    expect(graph.project.description).toBe('Test project.');
    expect(graph.project.frameworks).toEqual(['TypeScript']);
    expect(graph.layers.some((layer) => layer.name === 'Src')).toBe(true);

    // Merged data survives a fresh instance.
    const reloaded = createService(workDir);
    expect((await reloaded.search('login'))[0]!.summary).toBe('Validates credentials.');
  });
});
