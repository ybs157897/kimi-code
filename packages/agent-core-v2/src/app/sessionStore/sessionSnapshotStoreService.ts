/**
 * `sessionStore` domain (L2) — `ISessionSnapshotStore` implementation.
 *
 * Node-FS backed snapshot store: copies session directories, reads and rewrites
 * agent wire append-logs through `appendLogStore`, reads session metadata through
 * `docs`, and removes session artifacts through `hostFs`. Indexed forks derive
 * one cutoff from the main Agent, truncate other Agents by record time, prune
 * broken parent chains, and drop copied task/cron runtime state. Partial
 * targets are removed when a fork fails. Bound at App scope.
 *
 * Collaborators:
 * - resolves session storage addressing through `bootstrap`
 * - copies directories and removes files through `hostFs`
 * - reads/rewrites agent wire records through `appendLogStore`
 * - reads session metadata through `docs`
 * - removes from query-store projection through `queryStore`
 * - removes v1-compatible discovery records through `sessionStore`
 */

import { join } from 'pathe';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import type { WireRecord } from '#/wire/record';

import {
  ISessionSnapshotStore,
  type DeleteSnapshotInput,
  type ForkSnapshotInput,
  type ForkSnapshotResult,
  type SessionSnapshotMeta,
} from './sessionSnapshotStore';
import { ISessionLegacyIndexStore } from './sessionLegacyIndexStore';

const AGENT_WIRE_RECORD_KEY = 'wire.jsonl';
const STATE_JSON_KEY = 'state.json';
const LOGS_DIR = 'logs';
const SESSION_COLLECTION = 'session';

// ---- record-type predicates for visible-turn-index computation ----

interface AgentRecordLike {
  readonly type: string;
  readonly created_at?: number;
  readonly time?: number;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
    readonly origin?: {
      readonly kind?: string;
      readonly trigger?: string;
      readonly phase?: string;
    };
  };
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
  if (
    record.type === 'metadata' &&
    typeof record.created_at === 'number' &&
    Number.isFinite(record.created_at)
  ) {
    return record.created_at;
  }
  return undefined;
}

export class SessionSnapshotStoreService implements ISessionSnapshotStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IQueryStore private readonly queryStore: IQueryStore,
    @ISessionLegacyIndexStore private readonly legacyIndex: ISessionLegacyIndexStore,
  ) {}

  async fork(input: ForkSnapshotInput): Promise<ForkSnapshotResult> {
    validateTurnIndex(input.userVisibleTurnIndex);
    const sourceSessionDir = this.bootstrap.sessionDir(
      input.sourceWorkspaceId,
      input.sourceSessionId,
    );
    const targetSessionDir = this.bootstrap.sessionDir(
      input.targetWorkspaceId,
      input.targetSessionId,
    );
    await this.assertForkSourceExists(sourceSessionDir, input.sourceSessionId);
    await this.assertForkTargetAvailable(targetSessionDir, input.targetSessionId);
    try {
      await this.copySessionFiles(sourceSessionDir, targetSessionDir);
      const sourceMeta = await this.readMeta(input.sourceWorkspaceId, input.sourceSessionId);
      const sourceAgentIds =
        sourceMeta?.agents === undefined ? [] : Object.keys(sourceMeta.agents);
      if (input.userVisibleTurnIndex === undefined) {
        for (const agentId of sourceAgentIds) {
          await this.copyFullAgentWire(input, agentId);
        }
        return { sourceMeta, agentIds: sourceAgentIds };
      }
      const main = await this.copyIndexedMainWire(input, input.userVisibleTurnIndex);
      const retained = new Set<string>(['main']);
      for (const agentId of sourceAgentIds) {
        if (agentId === 'main') continue;
        if (await this.copySubagentWireThrough(input, agentId, main.cutoffTime)) {
          retained.add(agentId);
        }
      }
      pruneAgentsWithMissingParents(retained, sourceMeta?.agents);
      for (const agentId of sourceAgentIds) {
        if (!retained.has(agentId)) {
          await this.removeTargetAgent(input, agentId);
        }
      }
      for (const agentId of retained) {
        await this.dropIndexedForkRuntimeState(input, agentId);
      }
      return {
        sourceMeta,
        agentIds: sourceAgentIds.filter((agentId) => retained.has(agentId)),
        cutoffTime: main.cutoffTime,
        lastPrompt: main.lastPrompt,
      };
    } catch (error) {
      await this.hostFs.remove(targetSessionDir).catch(() => {});
      throw error;
    }
  }

  async delete(input: DeleteSnapshotInput): Promise<void> {
    await this.queryStore.delete(SESSION_COLLECTION, input.sessionId);
    await this.legacyIndex.remove(input.sessionId);

    const sessionDir = this.bootstrap.sessionDir(input.workspaceId, input.sessionId);
    try {
      await this.hostFs.remove(sessionDir);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  // ---- private helpers ----

  private async assertForkSourceExists(sourceDir: string, sessionId: string): Promise<void> {
    if (await this.pathExists(sourceDir)) return;
    throw new Error2(
      ErrorCodes.SESSION_NOT_FOUND,
      `Source session "${sessionId}" does not exist`,
    );
  }

  private async assertForkTargetAvailable(targetDir: string, sessionId: string): Promise<void> {
    if (!(await this.pathExists(targetDir))) return;
    throw new Error2(
      ErrorCodes.SESSION_ALREADY_EXISTS,
      `Target session "${sessionId}" already exists`,
    );
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await this.hostFs.stat(path);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

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

  private async copyFullAgentWire(
    input: ForkSnapshotInput,
    agentId: string,
  ): Promise<void> {
    const records = await this.readAgentWire(input, agentId);
    await this.writeAgentWire(input, agentId, records);
  }

  private async copyIndexedMainWire(
    input: ForkSnapshotInput,
    userVisibleTurnIndex: number,
  ): Promise<SliceResult> {
    const records = await this.readAgentWire(input, 'main');
    const slice = sliceRecordsAtTurn(records, userVisibleTurnIndex);
    await this.writeAgentWire(input, 'main', slice.records);
    return slice;
  }

  private async copySubagentWireThrough(
    input: ForkSnapshotInput,
    agentId: string,
    cutoffTime: number | undefined,
  ): Promise<boolean> {
    if (cutoffTime === undefined) return false;
    const records = await this.readAgentWire(input, agentId);
    let end = records.length;
    for (let index = 0; index < records.length; index += 1) {
      const time = recordTime(records[index]! as unknown as AgentRecordLike);
      if (time !== undefined && time > cutoffTime) {
        end = index;
        break;
      }
    }
    const retained = records.slice(0, end);
    if (retained.length === 0) return false;
    await this.writeAgentWire(input, agentId, retained);
    return true;
  }

  private async readAgentWire(
    input: ForkSnapshotInput,
    agentId: string,
  ): Promise<WireRecord[]> {
    const sourceScope = this.bootstrap.agentScope(
      input.sourceWorkspaceId,
      input.sourceSessionId,
      agentId,
    );
    return collect(
      this.appendLogStore.read<WireRecord>(sourceScope, AGENT_WIRE_RECORD_KEY),
    );
  }

  private async writeAgentWire(
    input: ForkSnapshotInput,
    agentId: string,
    records: readonly WireRecord[],
  ): Promise<void> {
    const targetScope = this.bootstrap.agentScope(
      input.targetWorkspaceId,
      input.targetSessionId,
      agentId,
    );
    const normalized = normalizeAgentWire(records);
    await this.appendLogStore.rewrite(targetScope, AGENT_WIRE_RECORD_KEY, normalized);
  }

  private async removeTargetAgent(
    input: ForkSnapshotInput,
    agentId: string,
  ): Promise<void> {
    await this.hostFs
      .remove(
        join(
          this.bootstrap.sessionDir(input.targetWorkspaceId, input.targetSessionId),
          'agents',
          agentId,
        ),
      )
      .catch((error) => {
        if (!isMissingFileError(error)) throw error;
      });
  }

  private async dropIndexedForkRuntimeState(
    input: ForkSnapshotInput,
    agentId: string,
  ): Promise<void> {
    const agentDir = join(
      this.bootstrap.sessionDir(input.targetWorkspaceId, input.targetSessionId),
      'agents',
      agentId,
    );
    await Promise.all([
      this.hostFs.remove(join(agentDir, 'tasks')).catch((error) => {
        if (!isMissingFileError(error)) throw error;
      }),
      this.hostFs.remove(join(agentDir, 'cron')).catch((error) => {
        if (!isMissingFileError(error)) throw error;
      }),
    ]);
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
  readonly lastPrompt: string | undefined;
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

  const start = turnStarts[turnIndex];
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
  const lastPrompt = promptText(
    (records[start] as unknown as AgentRecordLike).message?.content,
  );

  return { records: retained, cutoffTime, lastPrompt };
}

function isUserVisibleTurnInputRecord(record: AgentRecordLike): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  const kind = record.origin?.kind;
  switch (kind) {
    case undefined:
      return false;
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

function validateTurnIndex(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) return;
  throw new Error2(
    ErrorCodes.SESSION_STORE_INVALID_TURN_INDEX,
    `turnIndex must be a non-negative safe integer, got ${String(turnIndex)}`,
    { details: { turnIndex } },
  );
}

function pruneAgentsWithMissingParents(
  retained: Set<string>,
  agents: Readonly<Record<string, unknown>> | undefined,
): void {
  if (agents === undefined) return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const agentId of retained) {
      if (agentId === 'main') continue;
      const value = agents[agentId];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const parentAgentId = (value as Record<string, unknown>)['parentAgentId'];
      if (
        typeof parentAgentId === 'string' &&
        parentAgentId !== 'main' &&
        !retained.has(parentAgentId)
      ) {
        retained.delete(agentId);
        changed = true;
      }
    }
  }
}

function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return record['type'] === 'text' && typeof record['text'] === 'string'
        ? [record['text']]
        : [];
    })
    .join('\n')
    .trim();
  return text === '' ? undefined : text;
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
