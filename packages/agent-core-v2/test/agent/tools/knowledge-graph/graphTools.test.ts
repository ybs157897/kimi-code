import { describe, expect, it } from 'vitest';

import { GraphBuildTool } from '#/agent/tools/knowledge-graph/graphBuildTool';
import { GraphSearchTool } from '#/agent/tools/knowledge-graph/graphSearchTool';
import { GraphSummarizeTool } from '#/agent/tools/knowledge-graph/graphSummarizeTool';
import type {
  IKnowledgeGraphService,
  KnowledgeGraphSearchHit,
  KnowledgeGraphStatus,
} from '#/session/knowledgeGraph/knowledgeGraph';
import type { ExecutableToolContext } from '#/tool/toolContract';

const CTX: ExecutableToolContext = {
  turnId: 1,
  toolCallId: 'test-call',
  signal: new AbortController().signal,
};

function mockService(overrides: Partial<IKnowledgeGraphService>): IKnowledgeGraphService {
  return {
    dataDir: '/tmp/kg',
    getGraph: () => null,
    buildStatic: async () => ({ files: 0, functions: 0, classes: 0, edges: 0, durationMs: 0 }),
    search: async () => [],
    getStatus: async () => ({ state: 'missing' }) satisfies KnowledgeGraphStatus,
    listUnsummarizedFiles: async () => [],
    applyFileAnalyses: async () => ({ applied: 0 }),
    applyProjectSummary: async () => {},
    summarizationStatus: async () => ({ totalFiles: 0, summarizedFiles: 0, hasProjectSummary: false }),
    ...overrides,
  } as IKnowledgeGraphService;
}

const LOGIN_HIT: KnowledgeGraphSearchHit = {
  id: 'function:src/auth.ts:login',
  type: 'function',
  name: 'login',
  filePath: 'src/auth.ts',
  lineRange: [3, 5],
  summary: '',
  tags: [],
  score: 0.01,
};

describe('GraphBuildTool', () => {
  it('renders build stats on success', async () => {
    const updates: unknown[] = [];
    const tool = new GraphBuildTool(
      mockService({
        buildStatic: async (options) => {
          options?.onProgress?.({ phase: 'parsing', processedFiles: 6, totalFiles: 12 });
          updates.push('received');
          return { files: 12, functions: 34, classes: 5, edges: 60, durationMs: 42 };
        },
      }),
    );
    const execution = tool.resolveExecution({});
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute({ ...CTX, onUpdate: (update) => updates.push(update) });
    expect(result.isError).toBe(false);
    expect(updates).toContainEqual({
      kind: 'progress',
      text: 'Parsing source files (6/12)',
      percent: 50,
    });
    expect(result.output).toContain('files analyzed: 12');
    expect(result.output).toContain('functions: 34');
    expect(result.output).toContain('completed successfully');
  });

  it('reports failures as tool errors', async () => {
    const tool = new GraphBuildTool(
      mockService({
        buildStatic: async () => {
          throw new Error('boom');
        },
      }),
    );
    const execution = tool.resolveExecution({});
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('boom');
  });
});

describe('GraphSearchTool', () => {
  it('renders hits with file locations', async () => {
    const tool = new GraphSearchTool(mockService({ search: async () => [LOGIN_HIT] }));
    const execution = tool.resolveExecution({ query: 'login' });
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('[function] login (src/auth.ts:3-5)');
  });

  it('guides to GraphBuild when the graph is missing', async () => {
    const tool = new GraphSearchTool(mockService({}));
    const execution = tool.resolveExecution({ query: 'login' });
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('GraphBuild');
  });

  it('reports no-match against an existing graph', async () => {
    const tool = new GraphSearchTool(
      mockService({ getStatus: async () => ({ state: 'ready' }) }),
    );
    const execution = tool.resolveExecution({ query: 'nothing' });
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('No knowledge graph nodes matched');
  });
});

describe('GraphSummarizeTool', () => {
  it('guides to GraphBuild when the graph is missing', async () => {
    const tool = new GraphSummarizeTool(mockService({}));
    const execution = tool.resolveExecution({});
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('GraphBuild');
  });

  it('lists the pending batch with symbols in list mode', async () => {
    const tool = new GraphSummarizeTool(
      mockService({
        summarizationStatus: async () => ({ totalFiles: 5, summarizedFiles: 3, hasProjectSummary: false }),
        listUnsummarizedFiles: async () => [
          { filePath: 'src/auth.ts', functions: ['login'], classes: ['SessionManager'] },
        ],
      }),
    );
    const execution = tool.resolveExecution({});
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Progress: 3/5 files summarized');
    expect(result.output).toContain('src/auth.ts (functions: login; classes: SessionManager)');
  });

  it('merges analyses and reports progress', async () => {
    const tool = new GraphSummarizeTool(
      mockService({
        applyFileAnalyses: async () => ({ applied: 2 }),
        summarizationStatus: async () => ({ totalFiles: 5, summarizedFiles: 5, hasProjectSummary: false }),
      }),
    );
    const execution = tool.resolveExecution({
      analyses: [
        { filePath: 'src/a.ts', fileSummary: 'A.' },
        { filePath: 'src/b.ts', fileSummary: 'B.' },
      ],
    });
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Merged 2 file analyses');
    expect(result.output).toContain('5/5');
  });

  it('merges the project summary', async () => {
    const tool = new GraphSummarizeTool(
      mockService({
        summarizationStatus: async () => ({ totalFiles: 5, summarizedFiles: 5, hasProjectSummary: true }),
      }),
    );
    const execution = tool.resolveExecution({
      projectSummary: { description: 'A project.' },
    });
    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute(CTX);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Project summary merged');
  });
});
