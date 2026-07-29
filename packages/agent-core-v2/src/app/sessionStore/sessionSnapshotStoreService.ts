/**
 * `sessionStore` domain (L2) — `ISessionSnapshotStore` implementation.
 *
 * Node-FS backed snapshot store: copies session directories, reads and rewrites
 * agent wire append-logs through `appendLogStore`, reads session metadata through
 * `docs`, and removes session artifacts through `hostFs`. Bound at App scope.
 *
 * Collaborators:
 * - resolves session storage addressing through `bootstrap`
 * - copies directories and removes files through `hostFs`
 * - reads/rewrites agent wire records through `appendLogStore`
 * - reads session metadata through `docs`
 * - reads session summaries through `sessionIndex`
 * - removes from query-store projection through `queryStore`
 */

import { join } from 'pathe';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { isStorageError, StorageErrors } from '#/persistence/interface/storage';
import type { WireRecord } from '#/wire/record';

import {
  ISessionSnapshotStore,
  type DeleteSnapshotInput,
  type ForkSnapshotInput,
  type ForkSnapshotResult,
  type SessionSnapshotMeta,
} from './sessionSnapshotStore';

const AGENT_WIRE_RECORD_KEY = 'wire.jsonl';
const STATE_JSON_KEY = 'state.json';
const LOGS_DIR = 'logs';
const SESSION_COLLECTION = 'session';

// ---- record-type predicates for visible-turn-index computation ----

interface AgentRecordLike {
  readonly type: string;
  readonly time?: number;
  readonly message?: { readonly role?: string; readonly origin?: { readonly kind?: string; readonly trigger?: string; readonly phase?: string } };
  readonly origin?: { readonly kind?: string; readonly trigger?: string; readonly phase?: string };
}

function isUserVisibleTurnRecord(record: AgentRecordLike): boolean {
  if (record.type !== 'context.append_message') return false;
  const msg = record.message;
  if (!msg || msg.role !== 'user') return false;
  const kind = msg.origin?.kind;
  switch (kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return msg.origin!.trigger === 'user-slash';
    case 'shell_command':
      return msg.origin!.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'retry':
    case 'system_trigger':
      return false;
    default:
      return false;
  }
}

function recordTime(record: AgentRecordLike): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  return undefined;
}

export class SessionSnapshotStoreService implements ISessionSnapshotStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @ISessionIndex private readonly index: ISessionIndex,
    @IQueryStore private readonly queryStore: IQueryStore,
  ) {}

  async fork(input: ForkSnapshotInput): Promise<ForkSnapshotResult> {
    const sourceSessionDir = this.bootstrap.sessionDir(
      input.sourceWorkspaceId,
      input.sourceSessionId,
    );
    const targetSessionDir = this.bootstrap.sessionDir(
      input.targetWorkspaceId,
      input.targetSessionId,
    );

    // 1. Copy session files (excluding agent wire, state.json, logs).
    await this.copySessionFiles(sourceSessionDir, targetSessionDir);

    // 2. Read source metadata.
    const sourceMeta = await this.readMeta(input.sourceWorkspaceId, input.sourceSessionId);

    // 3. Copy agent wire records, possibly truncated at a turn boundary.
    const agentIds = sourceMeta?.agents !== undefined ? Object.keys(sourceMeta.agents) : [];

    let cutoffTime: number | undefined;
    for (const agentId of agentIds) {
      const agentCutoff = await this.copyAgentWire({
        sourceWorkspaceId: input.sourceWorkspaceId,
        sourceSessionId: input.sourceSessionId,
        targetWorkspaceId: input.targetWorkspaceId,
        targetSessionId: input.targetSessionId,
        agentId,
        userVisibleTurnIndex: input.userVisibleTurnIndex,
      });
      if (agentCutoff !== undefined) cutoffTime = agentCutoff;
    }

    return { sourceMeta: sourceMeta ?? undefined, agentIds, cutoffTime };
  }

  async delete(input: DeleteSnapshotInput): Promise<void> {
    // 1. Remove from QueryStore projection (best-effort).
    try {
      await this.queryStore.delete(SESSION_COLLECTION, input.sessionId);
    } catch (error) {
      // Only swallow STORAGE_LOCKED (another process holds the store);
      // all other errors must propagate to the caller.
      if (!isStorageError(error, StorageErrors.codes.STORAGE_LOCKED)) throw error;
    }

    // 2. Remove session directory.
    const sessionDir = this.bootstrap.sessionDir(input.workspaceId, input.sessionId);
    try {
      await this.hostFs.remove(sessionDir);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    // 3. Remove from session index (the directory-based discovery).
    // The directory removal above handles this for the v2 directory-based
    // index; v1 `session_index.jsonl` tombstoning is handled by the caller
    // (lifecycle) because it requires appending to the shared log.
  }

  // ---- private helpers ----

  private async copySessionFiles(sourceDir: string, targetDir: string): Promise<void> {
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(sourceDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '');
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly HostDirEntry[],
    relBase: string,
  ): Promise<void> {
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      // Skip agent wire logs (copied separately), state.json (recreated by
      // lifecycle), and logs (ephemeral).
      if (rel === STATE_JSON_KEY || rel === LOGS_DIR || entry.name === AGENT_WIRE_RECORD_KEY) {
        continue;
      }
      if (entry.isSymbolicLink === true) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        let children: readonly HostDirEntry[];
        try {
          children = await this.hostFs.readdir(sourcePath);
        } catch (error) {
          if (isMissingFileError(error)) continue;
          throw error;
        }
        await this.hostFs.mkdir(targetPath, { recursive: true });
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel);
      } else if (entry.isFile) {
        const data = await this.hostFs.readBytes(sourcePath);
        await this.hostFs.mkdir(targetDir, { recursive: true });
        await this.hostFs.writeBytes(targetPath, data);
      }
    }
  }

  private async copyAgentWire(args: {
    sourceWorkspaceId: string;
    sourceSessionId: string;
    targetWorkspaceId: string;
    targetSessionId: string;
    agentId: string;
    userVisibleTurnIndex?: number;
  }): Promise<number | undefined> {
    const sourceScope = this.bootstrap.agentScope(
      args.sourceWorkspaceId,
      args.sourceSessionId,
      args.agentId,
    );
    const targetScope = this.bootstrap.agentScope(
      args.targetWorkspaceId,
      args.targetSessionId,
      args.agentId,
    );

    const records = await collect(
      this.appendLogStore.read<WireRecord>(sourceScope, AGENT_WIRE_RECORD_KEY),
    );

    let retained: readonly WireRecord[];
    let cutoffTime: number | undefined;

    if (args.userVisibleTurnIndex !== undefined) {
      // Indexed fork: slice at the turn boundary.
      const slice = sliceRecordsAtTurn(records, args.userVisibleTurnIndex);
      retained = slice.records;
      cutoffTime = slice.cutoffTime;
    } else {
      // Full fork: keep all records.
      retained = [...records];
    }

    // Normalize metadata and append fork marker.
    const normalized = normalizeAgentWire(retained);

    await this.appendLogStore.rewrite(targetScope, AGENT_WIRE_RECORD_KEY, normalized);
    return cutoffTime;
  }

  private async readMeta(workspaceId: string, sessionId: string): Promise<SessionSnapshotMeta | undefined> {
    return this.docs.get<SessionSnapshotMeta>(
      this.bootstrap.sessionScope(workspaceId, sessionId),
      STATE_JSON_KEY,
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionSnapshotStore,
  SessionSnapshotStoreService,
  ScopeActivation.OnScopeCreated,
  'sessionStore',
);

// ---- pure helpers ----

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

function createWireMetadataRecord(): WireRecord {
  return { type: 'metadata', created_at: Date.now() } as unknown as WireRecord;
}

function forkedRecord(): WireRecord {
  return { type: 'forked', time: Date.now() } as WireRecord;
}

// ---- visible-turn-index slicing ----

interface SliceResult {
  readonly records: readonly WireRecord[];
  readonly cutoffTime: number | undefined;
}

function sliceRecordsAtTurn(
  records: readonly WireRecord[],
  turnIndex: number,
): SliceResult {
  // Validate turnIndex.
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) {
    throw new Error2(
      ErrorCodes.SESSION_STORE_INVALID_TURN_INDEX,
      `turnIndex must be a non-negative safe integer, got ${String(turnIndex)}`,
      { details: { turnIndex } },
    );
  }

  // Find the record index of the user-visible turn start.
  const turnStarts: number[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (isUserVisibleTurnRecord(record as unknown as AgentRecordLike)) {
      turnStarts.push(i);
    }
  }

  if (turnStarts[turnIndex] === undefined) {
    throw new Error2(
      ErrorCodes.SESSION_STORE_INVALID_TURN_INDEX,
      `Turn ${String(turnIndex)} was not found in the agent wire log (available turns: ${String(turnStarts.length)})`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }

  const start = turnStarts[turnIndex]!;
  const end = turnStarts[turnIndex + 1] ?? records.length;

  // Collect retained turn-input records (turn.prompt / turn.steer) that belong
  // to turns at or before turnIndex.
  const retainedTurnInputs = turnInputIndicesThrough(records, turnIndex);

  const retained = records
    .slice(0, end)
    .filter((_, index) => {
      const record = records[index]!;
      const agentRecord = record as unknown as AgentRecordLike;
      return !isUserVisibleTurnInputRecord(agentRecord) || retainedTurnInputs.has(index);
    });

  const cutoffTimes = retained
    .map((r) => recordTime(r as unknown as AgentRecordLike))
    .filter((time): time is number => time !== undefined);
  const cutoffTime = cutoffTimes.length === 0 ? undefined : Math.max(...cutoffTimes);

  return { records: retained, cutoffTime };
}

function isUserVisibleTurnInputRecord(record: AgentRecordLike): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  const kind = record.origin?.kind;
  switch (kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return record.origin!.trigger === 'user-slash';
    case 'shell_command':
      return record.origin!.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'retry':
    case 'system_trigger':
      return false;
    default:
      return false;
  }
}

function turnInputIndicesThrough(
  records: readonly WireRecord[],
  turnIndex: number,
): ReadonlySet<number> {
  const pending: number[] = [];
  const retained = new Set<number>();
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]! as unknown as AgentRecordLike;
    if (isUserVisibleTurnInputRecord(record)) {
      pending.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;

    const matchAt = findMatchingTurnInput(records, pending, records[index]!);
    if (matchAt !== -1) {
      const [inputIndex] = pending.splice(matchAt, 1);
      if (visibleTurnIndex <= turnIndex && inputIndex !== undefined) {
        retained.add(inputIndex);
      }
    }
    visibleTurnIndex += 1;
  }
  return retained;
}

function findMatchingTurnInput(
  records: readonly WireRecord[],
  pending: readonly number[],
  turnRecord: WireRecord,
): number {
  const turn = turnRecord as unknown as AgentRecordLike;
  const exact = pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]! as unknown as AgentRecordLike, turn),
  );
  if (exact !== -1) return exact;
  return pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]! as unknown as AgentRecordLike, turn),
  );
}

function turnInputMatchesRecord(
  inputRecord: AgentRecordLike,
  turnRecord: AgentRecordLike,
): boolean {
  if (
    (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') ||
    turnRecord.type !== 'context.append_message' ||
    turnRecord.message?.role !== 'user'
  ) {
    return false;
  }
  if (!sameTurnOrigin(inputRecord.origin?.kind, turnRecord.message?.origin?.kind)) return false;
  return true; // relaxed match (same as legacy's non-exact fallback behavior)
}

function sameTurnOrigin(inputKind: string | undefined, messageKind: string | undefined): boolean {
  if (inputKind === 'user') return messageKind === undefined || messageKind === 'user';
  return inputKind === messageKind;
}

function normalizeAgentWire(records: readonly WireRecord[]): WireRecord[] {
  const result = [...records];
  if (result.length === 0) {
    result.push(createWireMetadataRecord());
  } else if (result[0]?.type !== 'metadata') {
    result.unshift(createWireMetadataRecord());
  }
  result.push(forkedRecord());
  return result;
}
