/**
 * `sessionStore` domain (L2) — legacy session-index mutation contract.
 *
 * Serializes additions and removals in the v1-compatible session discovery
 * index so hard delete can remove every historical record before deleting the
 * durable session directory. App-scoped and independent of live Session
 * scopes.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface LegacySessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export interface ISessionLegacyIndexStore {
  readonly _serviceBrand: undefined;

  append(entry: LegacySessionIndexEntry): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export const ISessionLegacyIndexStore: ServiceIdentifier<ISessionLegacyIndexStore> =
  createDecorator<ISessionLegacyIndexStore>('sessionLegacyIndexStore');
