/**
 * `knowledgeGraph` domain — `IKnowledgeGraphService` implementation.
 *
 * Full static extraction runs in-process: walk the workspace (respecting
 * `.gitignore` via the engine's ignore filter plus the project-config dir),
 * parse every supported source file with `TreeSitterPlugin.analyzeFileFull`,
 * assemble nodes/edges through `GraphBuilder`, then persist
 * `knowledge-graph.json` + `meta.json` under `<workDir>/<projectConfigDirName>/knowledge-graph/`.
 * Summaries stay empty at this layer — LLM summarization is orchestrated
 * separately (skill/subagent workflow) and merged back onto the persisted
 * graph. Bound at Session scope; the graph is workspace data, so extraction
 * state is kept per session and reloaded lazily after restarts.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import {
  GraphBuilder,
  SearchEngine,
  TreeSitterPlugin,
  applyLLMLayers,
  builtinLanguageConfigs,
  createIgnoreFilter,
  isStale,
  type GraphNode,
  type KnowledgeGraph,
} from '@moonshot-ai/understand-core';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import {
  IKnowledgeGraphService,
  type FileAnalysisInput,
  type KnowledgeGraphBuildOptions,
  type KnowledgeGraphBuildStats,
  type KnowledgeGraphSearchHit,
  type KnowledgeGraphSearchOptions,
  type KnowledgeGraphStatus,
  type ProjectSummaryInput,
  type SummarizationStatus,
  type UnsummarizedFile,
} from './knowledgeGraph';

const GRAPH_DIR_NAME = 'knowledge-graph';
const GRAPH_FILE = 'knowledge-graph.json';
const META_FILE = 'meta.json';

/** Skip files larger than this — minified bundles and generated output. */
const MAX_FILE_BYTES = 512 * 1024;
/** Default cap on analyzed files; largest files are dropped first. */
const DEFAULT_MAX_FILES = 5000;

interface GraphMeta {
  readonly builtAt: string;
  readonly gitHash: string | null;
  readonly stats: KnowledgeGraphBuildStats;
  readonly fileHashes?: Record<string, string>;
}

function estimateComplexity(lineCount: number): 'simple' | 'moderate' | 'complex' {
  if (lineCount < 100) return 'simple';
  if (lineCount < 400) return 'moderate';
  return 'complex';
}

export class KnowledgeGraphService implements IKnowledgeGraphService {
  declare readonly _serviceBrand: undefined;

  readonly dataDir: string;

  private graph: KnowledgeGraph | null = null;
  private searchEngine: SearchEngine | null = null;

  constructor(
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    this.dataDir = join(workspace.workDir, bootstrap.projectConfigDirName, GRAPH_DIR_NAME);
  }

  async buildStatic(options: KnowledgeGraphBuildOptions = {}): Promise<KnowledgeGraphBuildStats> {
    const startedAt = performance.now();
    const workDir = this.workspace.workDir;

    const filter = createIgnoreFilter(workDir, [
      ...(options.extraIgnorePatterns ?? []),
      // Never analyze our own artifacts or the project-config dir.
      `${GRAPH_DIR_NAME}/`,
    ]);
    const files = this.collectFiles(workDir, filter.isIgnored, options.maxFiles ?? DEFAULT_MAX_FILES);
    const previousGraph = this.readPersistedGraph();
    const previousMeta = this.readMeta();
    const previousNodes = new Map(previousGraph?.nodes.map((node) => [node.id, node]));
    const fileHashes: Record<string, string> = {};
    let reusedFiles = 0;
    options.onProgress?.({
      phase: 'collecting',
      processedFiles: files.length,
      totalFiles: files.length,
    });

    const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter((c) => c.treeSitter));
    await plugin.init();

    const gitHash = readGitHash(workDir);
    const builder = new GraphBuilder(basename(workDir), gitHash ?? 'unknown');

    let functions = 0;
    let classes = 0;
    let processedFiles = 0;
    let lastProgressAt = 0;
    for (const absPath of files) {
      const rel = relative(workDir, absPath);
      let content: string;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        processedFiles += 1;
        continue;
      }
      const fileHash = hashContent(content);
      fileHashes[rel] = fileHash;
      const reusable = previousMeta?.fileHashes?.[rel] === fileHash;
      const previousFile = reusable ? previousNodes.get(`file:${rel}`) : undefined;
      const summaries: Record<string, string> = {};
      if (reusable) {
        reusedFiles += previousFile?.summary ? 1 : 0;
        for (const node of previousNodes.values()) {
          if (node.filePath !== rel || !node.summary) continue;
          if (node.type === 'function' || node.type === 'class') summaries[node.name] = node.summary;
        }
      }
      const { structure } = plugin.analyzeFileFull(absPath, content);
      const lineCount = content.split('\n').length;
      builder.addFileWithAnalysis(rel, structure, {
        summary: previousFile?.summary ?? '',
        tags: previousFile?.tags ?? [],
        complexity: estimateComplexity(lineCount),
        summaries,
        fileSummary: previousFile?.summary ?? '',
      });
      functions += structure.functions.length;
      classes += structure.classes.length;

      for (const imp of plugin.resolveImports(absPath, content)) {
        if (!imp.source.startsWith('./') && !imp.source.startsWith('../')) continue;
        const target = relative(workDir, imp.resolvedPath);
        if (!target.startsWith('..')) {
          builder.addImportEdge(rel, target);
        }
      }

      processedFiles += 1;
      if (
        processedFiles === files.length ||
        processedFiles - lastProgressAt >= Math.max(1, Math.ceil(files.length / 20))
      ) {
        lastProgressAt = processedFiles;
        options.onProgress?.({
          phase: 'parsing',
          processedFiles,
          totalFiles: files.length,
        });
      }
    }

    const graph = builder.build();
    const stats: KnowledgeGraphBuildStats = {
      files: files.length,
      functions,
      classes,
      edges: graph.edges.length,
      durationMs: Math.round(performance.now() - startedAt),
      reusedFiles,
    };

    mkdirSync(this.dataDir, { recursive: true });
    options.onProgress?.({
      phase: 'persisting',
      processedFiles: files.length,
      totalFiles: files.length,
    });
    writeFileSync(join(this.dataDir, GRAPH_FILE), JSON.stringify(graph));
    const meta: GraphMeta = { builtAt: new Date().toISOString(), gitHash, stats, fileHashes };
    writeFileSync(join(this.dataDir, META_FILE), JSON.stringify(meta, null, 2));

    this.graph = graph;
    this.searchEngine = new SearchEngine(graph.nodes);
    return stats;
  }

  async search(
    query: string,
    options: KnowledgeGraphSearchOptions = {},
  ): Promise<KnowledgeGraphSearchHit[]> {
    const engine = await this.ensureSearchEngine();
    if (!engine || !this.graph) return [];

    const nodeById = new Map<string, GraphNode>(this.graph.nodes.map((n) => [n.id, n]));
    return engine
      .search(query, {
        limit: options.limit ?? 20,
        types: options.types as GraphNode['type'][] | undefined,
      })
      .flatMap((result) => {
        const node = nodeById.get(result.nodeId);
        if (!node) return [];
        return [
          {
            id: node.id,
            type: node.type,
            name: node.name,
            filePath: node.filePath,
            lineRange: node.lineRange,
            summary: node.summary,
            tags: node.tags,
            score: result.score,
          } satisfies KnowledgeGraphSearchHit,
        ];
      });
  }

  async getStatus(): Promise<KnowledgeGraphStatus> {
    const meta = this.readMeta();
    if (!meta) return { state: 'missing' };
    const base = { builtAt: meta.builtAt, gitHash: meta.gitHash ?? undefined, stats: meta.stats };
    if (!meta.gitHash) return { state: 'ready', ...base };
    try {
      return { state: isStale(this.workspace.workDir, meta.gitHash).stale ? 'stale' : 'ready', ...base };
    } catch {
      return { state: 'ready', ...base };
    }
  }

  getGraph(): KnowledgeGraph | null {
    return this.graph;
  }

  async listUnsummarizedFiles(options: { limit?: number } = {}): Promise<UnsummarizedFile[]> {
    const graph = await this.ensureGraph();
    if (!graph) return [];

    const symbolsByFile = new Map<string, { functions: string[]; classes: string[] }>();
    for (const node of graph.nodes) {
      if (!node.filePath) continue;
      if (node.type !== 'function' && node.type !== 'class') continue;
      let entry = symbolsByFile.get(node.filePath);
      if (!entry) {
        entry = { functions: [], classes: [] };
        symbolsByFile.set(node.filePath, entry);
      }
      if (node.type === 'function') entry.functions.push(node.name);
      else entry.classes.push(node.name);
    }

    const result: UnsummarizedFile[] = [];
    for (const node of graph.nodes) {
      if (node.type !== 'file' || !node.filePath || node.summary) continue;
      const symbols = symbolsByFile.get(node.filePath);
      result.push({
        filePath: node.filePath,
        functions: symbols?.functions ?? [],
        classes: symbols?.classes ?? [],
      });
      if (result.length >= (options.limit ?? 20)) break;
    }
    return result;
  }

  async applyFileAnalyses(analyses: readonly FileAnalysisInput[]): Promise<{ applied: number }> {
    const graph = await this.ensureGraph();
    if (!graph) return { applied: 0 };

    const nodeById = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
    let applied = 0;
    for (const analysis of analyses) {
      const fileNode = nodeById.get(`file:${analysis.filePath}`);
      if (!fileNode) continue;
      fileNode.summary = analysis.fileSummary;
      if (analysis.tags) fileNode.tags = [...analysis.tags];
      if (analysis.complexity) fileNode.complexity = analysis.complexity;
      for (const [name, summary] of Object.entries(analysis.functionSummaries ?? {})) {
        const node = nodeById.get(`function:${analysis.filePath}:${name}`);
        if (node) node.summary = summary;
      }
      for (const [name, summary] of Object.entries(analysis.classSummaries ?? {})) {
        const node = nodeById.get(`class:${analysis.filePath}:${name}`);
        if (node) node.summary = summary;
      }
      applied++;
    }
    if (applied > 0) this.persist();
    return { applied };
  }

  async applyProjectSummary(summary: ProjectSummaryInput): Promise<void> {
    const graph = await this.ensureGraph();
    if (!graph) return;

    graph.project.description = summary.description;
    if (summary.frameworks) graph.project.frameworks = [...summary.frameworks];
    if (summary.layers) {
      graph.layers = applyLLMLayers(
        graph,
        summary.layers.map((layer) => ({
          name: layer.name,
          description: layer.description,
          filePatterns: [...layer.filePatterns],
        })),
      );
    }
    this.persist();
  }

  async summarizationStatus(): Promise<SummarizationStatus> {
    const graph = await this.ensureGraph();
    if (!graph) return { totalFiles: 0, summarizedFiles: 0, hasProjectSummary: false };
    const files = graph.nodes.filter((n) => n.type === 'file');
    return {
      totalFiles: files.length,
      summarizedFiles: files.filter((n) => n.summary.length > 0).length,
      hasProjectSummary: graph.project.description.length > 0,
    };
  }

  private async ensureSearchEngine(): Promise<SearchEngine | null> {
    if (this.searchEngine) return this.searchEngine;
    await this.ensureGraph();
    return this.searchEngine;
  }

  private async ensureGraph(): Promise<KnowledgeGraph | null> {
    if (this.graph) return this.graph;
    const graphPath = join(this.dataDir, GRAPH_FILE);
    if (!existsSync(graphPath)) return null;
    try {
      this.graph = JSON.parse(readFileSync(graphPath, 'utf8')) as KnowledgeGraph;
      this.searchEngine = new SearchEngine(this.graph.nodes);
      return this.graph;
    } catch {
      return null;
    }
  }

  /** Write the in-memory graph back to disk and rebuild the search index. */
  private persist(): void {
    if (!this.graph) return;
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(join(this.dataDir, GRAPH_FILE), JSON.stringify(this.graph));
    this.searchEngine = new SearchEngine(this.graph.nodes);
  }

  private readMeta(): GraphMeta | null {
    const metaPath = join(this.dataDir, META_FILE);
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, 'utf8')) as GraphMeta;
    } catch {
      return null;
    }
  }

  private readPersistedGraph(): KnowledgeGraph | null {
    const graphPath = join(this.dataDir, GRAPH_FILE);
    if (!existsSync(graphPath)) return null;
    try {
      return JSON.parse(readFileSync(graphPath, 'utf8')) as KnowledgeGraph;
    } catch {
      return null;
    }
  }

  private collectFiles(
    workDir: string,
    isIgnored: (rel: string) => boolean,
    maxFiles: number,
  ): string[] {
    const extensions = sourceExtensions();
    const candidates: { absPath: string; size: number }[] = [];

    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relative(workDir, abs);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || isIgnored(`${rel}/`)) continue;
          walk(abs);
        } else if (entry.isFile()) {
          if (!extensions.has(extnameLower(entry.name)) || isIgnored(rel)) continue;
          try {
            const { size } = statSync(abs);
            if (size > 0 && size <= MAX_FILE_BYTES) candidates.push({ absPath: abs, size });
          } catch {
            // Unreadable file — skip.
          }
        }
      }
    };
    walk(workDir);

    // Deterministic order, then cap by dropping the largest files.
    candidates.sort((a, b) => a.absPath.localeCompare(b.absPath));
    return candidates
      .sort((a, b) => a.size - b.size)
      .slice(0, maxFiles)
      .map((c) => c.absPath)
      .sort();
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

let cachedExtensions: Set<string> | null = null;
function sourceExtensions(): Set<string> {
  cachedExtensions ??= new Set(
    builtinLanguageConfigs
      .filter((c) => c.treeSitter)
      .flatMap((c) => c.extensions.map((e) => e.toLowerCase())),
  );
  return cachedExtensions;
}

function extnameLower(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx).toLowerCase();
}

function readGitHash(workDir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IKnowledgeGraphService,
  KnowledgeGraphService,
  ScopeActivation.OnDemand,
  'session-knowledge-graph',
);
