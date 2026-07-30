import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionDeletionStore } from '#/app/sessionStore/sessionDeletionStore';
import { SessionDeletionStoreService } from '#/app/sessionStore/sessionDeletionStoreService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';

import { stubBootstrap } from '../bootstrap/stubs';

describe('SessionDeletionStoreService', () => {
  let homeDir: string;
  let host: ScopedTestHost | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionDeletionStore,
      SessionDeletionStoreService,
      ScopeActivation.OnDemand,
      'sessionStore',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'session-delete-store-'));
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(appendLog?: IAppendLogStore): ISessionDeletionStore {
    host?.dispose();
    const storage = new FileStorageService(homeDir);
    host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IFileSystemStorageService, storage),
      stubPair(IAppendLogStore, appendLog ?? new AppendLogStore(storage)),
    ]);
    return host.app.accessor.get(ISessionDeletionStore);
  }

  it('folds the last valid record per session across process restarts', async () => {
    const first = build();
    await first.begin({ workspaceId: 'ws-a', sessionId: 'session-a' });
    await first.complete({ workspaceId: 'ws-a', sessionId: 'session-a' });
    await first.clear('session-a');
    await first.begin({ workspaceId: 'ws-b', sessionId: 'session-a' });
    await first.begin({ workspaceId: 'ws-a', sessionId: 'session-b' });
    await first.complete({ workspaceId: 'ws-a', sessionId: 'session-b' });

    const restarted = build();

    await expect(restarted.get('session-a')).resolves.toEqual({
      workspaceId: 'ws-b',
      sessionId: 'session-a',
      state: 'pending',
    });
    await expect(restarted.get('session-b')).resolves.toEqual({
      workspaceId: 'ws-a',
      sessionId: 'session-b',
      state: 'completed',
    });
    await expect(restarted.listPending()).resolves.toEqual([
      { workspaceId: 'ws-b', sessionId: 'session-a', state: 'pending' },
    ]);
  });

  it('does not publish an intent in memory when its durable flush fails', async () => {
    const ioFailure = new StorageError(
      StorageErrors.codes.STORAGE_IO_FAILED,
      'journal flush failed',
    );
    let reads = 0;
    const store = build({
      _serviceBrand: undefined,
      append: () => {},
      read: async function* () {
        reads += 1;
        if (reads === 2) {
          yield undefined as never;
          throw ioFailure;
        }
      },
      rewrite: () => Promise.resolve(),
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
      acquire: () => ({ dispose: () => {} }),
    });

    await expect(
      store.begin({ workspaceId: 'ws-a', sessionId: 'session-a' }),
    ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_IO_FAILED });
    await expect(store.get('session-a')).resolves.toBeUndefined();
  });

  it('refreshes last-record-wins state written by another live process', async () => {
    const first = build();
    await expect(first.get('session-a')).resolves.toBeUndefined();

    const externalStorage = new FileStorageService(homeDir);
    const externalHost = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IFileSystemStorageService, externalStorage),
      stubPair(IAppendLogStore, new AppendLogStore(externalStorage)),
    ]);
    try {
      const second = externalHost.app.accessor.get(ISessionDeletionStore);
      await second.begin({ workspaceId: 'ws-a', sessionId: 'session-a' });

      await expect(first.get('session-a')).resolves.toEqual({
        workspaceId: 'ws-a',
        sessionId: 'session-a',
        state: 'pending',
      });
    } finally {
      externalHost.dispose();
    }
  });
});
