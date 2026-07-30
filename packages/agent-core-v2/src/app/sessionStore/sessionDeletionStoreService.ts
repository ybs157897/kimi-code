/**
 * `sessionStore` domain (L2) — durable hard-delete journal implementation.
 *
 * Folds a versioned append log through `bootstrap` and `appendLogStore`, with
 * the latest valid record for each session defining whether its deletion is
 * pending, completed, or cleared. Mutations become visible only after their
 * append is durably flushed. Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';

import {
  ISessionDeletionStore,
  type SessionDeletionIntent,
} from './sessionDeletionStore';

const JOURNAL_KEY = 'session-deletions.jsonl';
const JOURNAL_VERSION = 1;

type SessionDeletionJournalState = SessionDeletionIntent['state'] | 'cleared';

interface SessionDeletionJournalRecord {
  readonly version: typeof JOURNAL_VERSION;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly state: SessionDeletionJournalState;
}

export class SessionDeletionStoreService implements ISessionDeletionStore {
  declare readonly _serviceBrand: undefined;

  private records = new Map<string, SessionDeletionJournalRecord>();
  private operations: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
  ) {}

  begin(input: Omit<SessionDeletionIntent, 'state'>): Promise<void> {
    return this.run(async () => {
      await this.refresh();
      const current = this.records.get(input.sessionId);
      if (
        current?.workspaceId === input.workspaceId &&
        (current.state === 'pending' || current.state === 'completed')
      ) {
        return;
      }
      await this.append({ version: JOURNAL_VERSION, ...input, state: 'pending' });
    });
  }

  complete(input: Omit<SessionDeletionIntent, 'state'>): Promise<void> {
    return this.run(async () => {
      await this.refresh();
      const current = this.records.get(input.sessionId);
      if (current?.workspaceId === input.workspaceId && current.state === 'completed') return;
      await this.append({ version: JOURNAL_VERSION, ...input, state: 'completed' });
    });
  }

  clear(sessionId: string): Promise<void> {
    return this.run(async () => {
      await this.refresh();
      const current = this.records.get(sessionId);
      if (current === undefined || current.state === 'cleared') return;
      await this.append({
        version: JOURNAL_VERSION,
        workspaceId: current.workspaceId,
        sessionId,
        state: 'cleared',
      });
    });
  }

  get(sessionId: string): Promise<SessionDeletionIntent | undefined> {
    return this.run(async () => {
      await this.refresh();
      return toIntent(this.records.get(sessionId));
    });
  }

  list(): Promise<readonly SessionDeletionIntent[]> {
    return this.run(async () => {
      await this.refresh();
      return [...this.records.values()]
        .map(toIntent)
        .filter((intent): intent is SessionDeletionIntent => intent !== undefined);
    });
  }

  listPending(): Promise<readonly SessionDeletionIntent[]> {
    return this.run(async () => {
      await this.refresh();
      const pending: SessionDeletionIntent[] = [];
      for (const record of this.records.values()) {
        if (record.state !== 'pending') continue;
        pending.push({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          state: record.state,
        });
      }
      return pending;
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refresh(): Promise<void> {
    const records = new Map<string, SessionDeletionJournalRecord>();
    for await (const value of this.appendLogStore.read<unknown>(this.scope, JOURNAL_KEY)) {
      const record = parseRecord(value);
      if (record !== undefined) records.set(record.sessionId, record);
    }
    this.records = records;
  }

  private async append(record: SessionDeletionJournalRecord): Promise<void> {
    this.appendLogStore.append(this.scope, JOURNAL_KEY, record);
    await this.refresh();
  }

  private get scope(): string {
    return this.bootstrap.scope('store');
  }
}

function parseRecord(value: unknown): SessionDeletionJournalRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['version'] !== JOURNAL_VERSION) return undefined;
  if (typeof record['workspaceId'] !== 'string' || record['workspaceId'] === '') return undefined;
  if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') return undefined;
  const state = record['state'];
  if (state !== 'pending' && state !== 'completed' && state !== 'cleared') return undefined;
  return {
    version: JOURNAL_VERSION,
    workspaceId: record['workspaceId'],
    sessionId: record['sessionId'],
    state,
  };
}

function toIntent(
  record: SessionDeletionJournalRecord | undefined,
): SessionDeletionIntent | undefined {
  if (record === undefined || record.state === 'cleared') return undefined;
  return {
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    state: record.state,
  };
}

registerScopedService(
  LifecycleScope.App,
  ISessionDeletionStore,
  SessionDeletionStoreService,
  ScopeActivation.OnDemand,
  'sessionStore',
);
