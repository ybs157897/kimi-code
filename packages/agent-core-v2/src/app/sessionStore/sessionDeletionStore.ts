/**
 * `sessionStore` domain (L2) — durable hard-delete journal contract.
 *
 * Persists the last-record-wins deletion state used by `sessionLifecycle` to
 * recover interrupted hard deletes and by `sessionIndex` to suppress sessions
 * while deletion is pending or completed. App-scoped and independent of live
 * Session scopes.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type SessionDeletionState = 'pending' | 'completed';

export interface SessionDeletionIntent {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly state: SessionDeletionState;
}

export interface ISessionDeletionStore {
  readonly _serviceBrand: undefined;

  begin(input: Omit<SessionDeletionIntent, 'state'>): Promise<void>;
  complete(input: Omit<SessionDeletionIntent, 'state'>): Promise<void>;
  clear(sessionId: string): Promise<void>;
  get(sessionId: string): Promise<SessionDeletionIntent | undefined>;
  list(): Promise<readonly SessionDeletionIntent[]>;
  listPending(): Promise<readonly SessionDeletionIntent[]>;
}

export const ISessionDeletionStore: ServiceIdentifier<ISessionDeletionStore> =
  createDecorator<ISessionDeletionStore>('sessionDeletionStore');
