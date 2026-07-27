/**
 * `sessionExtension` domain — per-Session catalog and reload scenarios.
 *
 * Exercises the real scoped registration with a stub App loader, proving that
 * workspace snapshots stay isolated and explicit reload replaces the catalog.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import type {
  ExtensionLoadResult,
  LoadedExtension,
} from '#/app/extension/extension.types';
import { IExtensionLoaderService } from '#/app/extension/extensionLoader';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionExtensionService } from '#/session/extension/sessionExtension';
import { SessionExtensionService } from '#/session/extension/sessionExtensionService';

function loaded(id: string, path: string): LoadedExtension {
  return {
    id,
    path,
    resolvedPath: path,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
}

describe('SessionExtensionService', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionExtensionService,
      SessionExtensionService,
      ScopeActivation.OnScopeCreated,
      'sessionExtension',
    );
  });

  it('keeps extension snapshots isolated by Session cwd', async () => {
    const loader = {
      _serviceBrand: undefined,
      load: async ({ cwd }: { cwd: string }): Promise<ExtensionLoadResult> => ({
        extensions: [loaded(cwd.slice(1), `${cwd}/extension.ts`)],
        errors: [],
      }),
    } satisfies IExtensionLoaderService;
    const host = createScopedTestHost([stubPair(IExtensionLoaderService, loader)]);
    try {
      const first = host.child(LifecycleScope.Session, 'first', [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 'first',
            workspaceId: 'workspace',
            sessionDir: '/sessions/first',
            sessionScope: 'sessions/first',
            cwd: '/alpha',
          }),
        ),
      ]);
      const second = host.child(LifecycleScope.Session, 'second', [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 'second',
            workspaceId: 'workspace',
            sessionDir: '/sessions/second',
            sessionScope: 'sessions/second',
            cwd: '/beta',
          }),
        ),
      ]);
      const firstExtensions = first.accessor.get(ISessionExtensionService);
      const secondExtensions = second.accessor.get(ISessionExtensionService);

      await Promise.all([firstExtensions.ready, secondExtensions.ready]);

      expect(firstExtensions.list().map((extension) => extension.id)).toEqual(['alpha']);
      expect(secondExtensions.list().map((extension) => extension.id)).toEqual(['beta']);
    } finally {
      host.dispose();
    }
  });

  it('replaces the active snapshot and announces explicit reload', async () => {
    let revision = 0;
    const loader = {
      _serviceBrand: undefined,
      load: async (): Promise<ExtensionLoadResult> => {
        revision += 1;
        return {
          extensions: [loaded(`revision-${String(revision)}`, `/revision-${String(revision)}.ts`)],
          errors: [],
        };
      },
    } satisfies IExtensionLoaderService;
    const host = createScopedTestHost([stubPair(IExtensionLoaderService, loader)]);
    try {
      const session = host.child(LifecycleScope.Session, 'session', [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 'session',
            workspaceId: 'workspace',
            sessionDir: '/sessions/session',
            sessionScope: 'sessions/session',
            cwd: '/workspace',
          }),
        ),
      ]);
      const extensions = session.accessor.get(ISessionExtensionService);
      await extensions.ready;
      const summaries: string[][] = [];
      const transitions: string[] = [];
      const participant = extensions.registerReloadParticipant({
        prepareForReload: async () => {
          transitions.push(`stop:${extensions.list()[0]?.id ?? 'none'}`);
        },
        activateReloadedCatalog: async () => {
          transitions.push(`start:${extensions.list()[0]?.id ?? 'none'}`);
        },
      });
      const subscription = extensions.onDidReload((summary) => {
        summaries.push([...summary.active]);
      });

      await extensions.reload();

      expect(extensions.list().map((extension) => extension.id)).toEqual(['revision-2']);
      expect(transitions).toEqual(['stop:revision-1', 'start:revision-2']);
      expect(summaries).toEqual([['/revision-2.ts']]);
      participant.dispose();
      subscription.dispose();
    } finally {
      host.dispose();
    }
  });

  it('waits for the initial catalog before listing commands', async () => {
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contribution = loaded('example', '/workspace/extension.ts');
    contribution.commands.set('hello', {
      name: 'hello',
      description: 'hello command',
      prompt: () => 'hello',
    });
    const loader = {
      _serviceBrand: undefined,
      load: async (): Promise<ExtensionLoadResult> => {
        await loading;
        return { extensions: [contribution], errors: [] };
      },
    } satisfies IExtensionLoaderService;
    const host = createScopedTestHost([stubPair(IExtensionLoaderService, loader)]);
    try {
      const session = host.child(LifecycleScope.Session, 'session', [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 'session',
            workspaceId: 'workspace',
            sessionDir: '/sessions/session',
            sessionScope: 'sessions/session',
            cwd: '/workspace',
          }),
        ),
      ]);
      const extensions = session.accessor.get(ISessionExtensionService);
      let settled = false;
      const commands = extensions.listCommands().then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      release();
      await expect(commands).resolves.toEqual([
        {
          extensionId: 'example',
          name: 'hello',
          description: 'hello command',
        },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('serializes concurrent reloads in request order', async () => {
    let revision = 0;
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondLoading = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const order: string[] = [];
    const loader = {
      _serviceBrand: undefined,
      load: async (): Promise<ExtensionLoadResult> => {
        revision += 1;
        const current = revision;
        order.push(`start:${String(current)}`);
        if (current === 2) {
          markSecondStarted();
          await secondLoading;
        }
        order.push(`end:${String(current)}`);
        return {
          extensions: [loaded(`revision-${String(current)}`, `/revision-${String(current)}.ts`)],
          errors: [],
        };
      },
    } satisfies IExtensionLoaderService;
    const host = createScopedTestHost([stubPair(IExtensionLoaderService, loader)]);
    try {
      const session = host.child(LifecycleScope.Session, 'session', [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 'session',
            workspaceId: 'workspace',
            sessionDir: '/sessions/session',
            sessionScope: 'sessions/session',
            cwd: '/workspace',
          }),
        ),
      ]);
      const extensions = session.accessor.get(ISessionExtensionService);
      await extensions.ready;

      const first = extensions.reload();
      await secondStarted;
      const second = extensions.reload();
      await Promise.resolve();

      expect(revision).toBe(2);
      releaseSecond();
      await Promise.all([first, second]);
      expect(order).toEqual([
        'start:1',
        'end:1',
        'start:2',
        'end:2',
        'start:3',
        'end:3',
      ]);
      expect(extensions.list().map((extension) => extension.id)).toEqual(['revision-3']);
    } finally {
      host.dispose();
    }
  });
});
