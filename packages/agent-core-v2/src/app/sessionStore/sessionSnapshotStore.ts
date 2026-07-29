/**
 * `sessionStore` domain (L2) — snapshot-Store contract for fork & delete.
 *
 * `ISessionSnapshotStore` is a domain-specific persistence Store that abstracts
 * the data-layer operations of forking and deleting a session: copying session
 * files, rewriting agent wire records, reading/writing metadata, and cleaning
 * up persisted data. It is consumed by `sessionLifecycle` so that the lifecycle
 * orchestrator never directly traverses Node paths or truncates `wire.jsonl`.
 *
 * `fork()` copies session data from a source to a target, preserving the source
 * untouched. For a full fork (`userVisibleTurnIndex` absent) the entire agent
 * wire log is copied and a forked marker appended. For an indexed fork
 * (`userVisibleTurnIndex` present), only records up to (and including) that
 * turn are retained — the caller must then clean up subagents, tasks,
 * interactions, and cron entries that reference records past the cutoff.
 *
 * `delete()` performs a hard delete by tombstones the session and removing its
 * persisted artifacts. The operation is idempotent: repeating it after a
 * partial or complete prior deletion succeeds without error.
 *
 * App-scoped — the Store operates on persisted data independent of any live
 * session scope. Callers must drain/close a live session before calling
 * `delete()`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Subset of session metadata returned by the snapshot store. Contains only the
 * fields the caller (`sessionLifecycle`) needs to seed the target session
 * (title, last prompt, custom metadata) and to know which agents to create.
 * Defined locally so `sessionStore` (L2) stays decoupled from `sessionMetadata`
 * (L6).
 */
export interface SessionSnapshotMeta {
  readonly title?: string;
  readonly isCustomTitle?: boolean;
  readonly lastPrompt?: string;
  readonly custom?: Record<string, unknown>;
  readonly forkedFrom?: string;
  readonly agents?: Readonly<Record<string, unknown>>;
}

export interface ForkSnapshotInput {
  readonly sourceWorkspaceId: string;
  readonly sourceSessionId: string;
  readonly targetWorkspaceId: string;
  readonly targetSessionId: string;
  /**
   * When absent, the entire source session is copied (full fork). When present,
   * only records up to (and including) this user-visible turn index are retained
   * (indexed fork). The index counts user-visible turns (prompts, user-slash
   * skill/plugin commands, shell input) starting from 0 — it is NOT the
   * transcript ordinal.
   */
  readonly userVisibleTurnIndex?: number;
}

export interface ForkSnapshotResult {
  /** The source session's metadata read from `state.json` via
   * `IAtomicDocumentStore.get()`. Returns `undefined` when the source session
   * has no persisted `state.json` document (e.g. the session was never
   * materialized or `state.json` was never written). Callers use this to seed
   * the target title, last prompt, and custom metadata. */
  readonly sourceMeta: SessionSnapshotMeta | undefined;
  /** The ids of every agent whose wire log was copied to the target. */
  readonly agentIds: readonly string[];
  /** For an indexed fork, the epoch-ms timestamp of the last retained record;
   * undefined for a full fork. Callers use this to clean up subagents, tasks,
   * interactions, and cron entries that reference records past the cutoff. */
  readonly cutoffTime?: number;
}

export interface DeleteSnapshotInput {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface ISessionSnapshotStore {
  readonly _serviceBrand: undefined;

  fork(input: ForkSnapshotInput): Promise<ForkSnapshotResult>;
  delete(input: DeleteSnapshotInput): Promise<void>;
}

export const ISessionSnapshotStore: ServiceIdentifier<ISessionSnapshotStore> =
  createDecorator<ISessionSnapshotStore>('sessionSnapshotStore');
