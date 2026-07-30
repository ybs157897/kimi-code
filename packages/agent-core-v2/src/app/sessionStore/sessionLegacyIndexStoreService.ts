/**
 * `sessionStore` domain (L2) — legacy session-index mutation implementation.
 *
 * Serializes v1-compatible index appends and whole-log rewrites through
 * `appendLogStore`. Removal preserves unrelated JSON records and drops every
 * historical record carrying the deleted session id. Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';

import {
  ISessionLegacyIndexStore,
  type LegacySessionIndexEntry,
} from './sessionLegacyIndexStore';

const INDEX_SCOPE = '';
const INDEX_KEY = 'session_index.jsonl';

export class SessionLegacyIndexStoreService implements ISessionLegacyIndexStore {
  declare readonly _serviceBrand: undefined;

  private operations: Promise<void> = Promise.resolve();

  constructor(@IAppendLogStore private readonly appendLogStore: IAppendLogStore) {}

  append(entry: LegacySessionIndexEntry): Promise<void> {
    return this.run(async () => {
      this.appendLogStore.append(INDEX_SCOPE, INDEX_KEY, entry);
      await this.appendLogStore.flush();
    });
  }

  remove(sessionId: string): Promise<void> {
    return this.run(async () => {
      const records: unknown[] = [];
      for await (const record of this.appendLogStore.read<unknown>(INDEX_SCOPE, INDEX_KEY)) {
        if (!hasSessionId(record, sessionId)) records.push(record);
      }
      await this.appendLogStore.rewrite(INDEX_SCOPE, INDEX_KEY, records);
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
}

function hasSessionId(value: unknown, sessionId: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['sessionId'] === sessionId
  );
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyIndexStore,
  SessionLegacyIndexStoreService,
  ScopeActivation.OnDemand,
  'sessionStore',
);
