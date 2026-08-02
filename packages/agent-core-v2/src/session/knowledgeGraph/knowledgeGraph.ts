/**
 * `knowledgeGraph` domain — workspace knowledge-graph service contract.
 *
 * A Session-scoped service that builds (and later refreshes) a tree-sitter
 * knowledge graph of the session workspace: files, functions, classes and
 * their import/containment relationships, powered by the vendored
 * `@moonshot-ai/understand-core` engine. The graph is persisted under the
 * project-config dir (`<workDir>/<projectConfigDirName>/knowledge-graph/`)
 * and exposed to the agent through tools (graph domain) — the service itself
 * never talks to an LLM and never injects anything into the context.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { KnowledgeGraph } from '@moonshot-ai/understand-core';

export type KnowledgeGraphState = 'missing' | 'ready' | 'stale';

export interface KnowledgeGraphBuildStats {
  readonly files: number;
  readonly functions: number;
  readonly classes: number;
  readonly edges: number;
  readonly durationMs: number;
}

export interface KnowledgeGraphStatus {
  readonly state: KnowledgeGraphState;
  readonly builtAt?: string;
  readonly gitHash?: string;
  readonly stats?: KnowledgeGraphBuildStats;
}

export interface KnowledgeGraphBuildOptions {
  /** Extra gitignore-style patterns excluded from analysis (highest priority). */
  readonly extraIgnorePatterns?: readonly string[];
  /** Hard cap on analyzed files (largest files are dropped first). */
  readonly maxFiles?: number;
}

export interface KnowledgeGraphSearchOptions {
  readonly limit?: number;
  readonly types?: readonly string[];
}

export interface KnowledgeGraphSearchHit {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly filePath?: string;
  readonly lineRange?: readonly [number, number];
  readonly summary: string;
  readonly tags: readonly string[];
  /** Relevance score: 0 = perfect match, 1 = worst match. */
  readonly score: number;
}

/** A file node still missing LLM summaries, with the symbols to summarize. */
export interface UnsummarizedFile {
  readonly filePath: string;
  readonly functions: readonly string[];
  readonly classes: readonly string[];
}

/** LLM-produced analysis for one file, merged back onto the graph. */
export interface FileAnalysisInput {
  readonly filePath: string;
  readonly fileSummary: string;
  readonly tags?: readonly string[];
  readonly complexity?: 'simple' | 'moderate' | 'complex';
  readonly functionSummaries?: Record<string, string>;
  readonly classSummaries?: Record<string, string>;
}

/** LLM-produced project-level summary, merged onto graph metadata + layers. */
export interface ProjectSummaryInput {
  readonly description: string;
  readonly frameworks?: readonly string[];
  readonly layers?: readonly {
    name: string;
    description: string;
    filePatterns: readonly string[];
  }[];
}

export interface SummarizationStatus {
  readonly totalFiles: number;
  readonly summarizedFiles: number;
  readonly hasProjectSummary: boolean;
}

export interface IKnowledgeGraphService {
  readonly _serviceBrand: undefined;

  /** Run a full static extraction over the workspace and persist the graph. */
  buildStatic(options?: KnowledgeGraphBuildOptions): Promise<KnowledgeGraphBuildStats>;

  /** Fuzzy-search graph nodes; lazily loads a persisted graph when needed. */
  search(
    query: string,
    options?: KnowledgeGraphSearchOptions,
  ): Promise<KnowledgeGraphSearchHit[]>;

  /** Report whether a graph exists and whether it is stale (git-hash based). */
  getStatus(): Promise<KnowledgeGraphStatus>;

  /** The in-memory graph, or null when none has been built/loaded. */
  getGraph(): KnowledgeGraph | null;

  /** Absolute path of the directory holding the persisted graph artifacts. */
  readonly dataDir: string;

  /**
   * File nodes still lacking summaries (deepest-first), for the agent-driven
   * LLM summarization loop. Lazily loads a persisted graph when needed.
   */
  listUnsummarizedFiles(options?: { limit?: number }): Promise<UnsummarizedFile[]>;

  /** Merge LLM file analyses onto graph nodes and persist. Returns applied count. */
  applyFileAnalyses(analyses: readonly FileAnalysisInput[]): Promise<{ applied: number }>;

  /** Merge the LLM project summary onto graph metadata/layers and persist. */
  applyProjectSummary(summary: ProjectSummaryInput): Promise<void>;

  /** Progress of the optional LLM summarization pass. */
  summarizationStatus(): Promise<SummarizationStatus>;
}

export const IKnowledgeGraphService: ServiceIdentifier<IKnowledgeGraphService> =
  createDecorator<IKnowledgeGraphService>('knowledgeGraphService');
