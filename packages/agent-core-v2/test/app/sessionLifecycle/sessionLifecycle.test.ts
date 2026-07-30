import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { errorInfo } from '#/_base/errors/codes';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IWorkspaceFileSystem,
  IWorkspaceFileSystemFactory,
  type WorkspaceFileSystemContext,
} from '#/os/interface/workspaceFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IEventService } from '#/app/event/event';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { IAgentPlanService } from '#/agent/plan/plan';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionSecondaryModelWarningService } from '#/session/subagent/secondaryModelWarning';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycleService';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import {
  ISessionDeletionStore,
  type SessionDeletionIntent,
} from '#/app/sessionStore/sessionDeletionStore';
import {
  ISessionLegacyIndexStore,
  type LegacySessionIndexEntry,
} from '#/app/sessionStore/sessionLegacyIndexStore';
import {
  ISessionSnapshotStore,
  type ForkSnapshotInput,
  type ForkSnapshotResult,
} from '#/app/sessionStore/sessionSnapshotStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { IWireService } from '#/wire/wire';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

function bootstrapStub(): IBootstrapService {
  return {
    sessionsDir: '/tmp/sessions',
    homeDir: '/tmp',
    sessionScope: (workspaceId: string, sessionId: string) =>
      `sessions/${workspaceId}/${sessionId}`,
    agentScope: (workspaceId: string, sessionId: string, agentId: string) =>
      `sessions/${workspaceId}/${sessionId}/agents/${agentId}`,
    sessionDir: (workspaceId: string, sessionId: string) =>
      `/tmp/sessions/${workspaceId}/${sessionId}`,
  } as IBootstrapService;
}

function tmpBootstrapStub(root: string): IBootstrapService {
  return {
    sessionsDir: join(root, 'sessions'),
    homeDir: root,
    sessionScope: (workspaceId: string, sessionId: string) =>
      `sessions/${workspaceId}/${sessionId}`,
    agentScope: (workspaceId: string, sessionId: string, agentId: string) =>
      `sessions/${workspaceId}/${sessionId}/agents/${agentId}`,
    sessionDir: (workspaceId: string, sessionId: string) =>
      join(root, 'sessions', workspaceId, sessionId),
  } as IBootstrapService;
}

function cronStoreStub(
  initial: readonly CronTask[] = [],
): ICronTaskPersistence & { readonly docs: Map<string, CronTask> } {
  const docs = new Map(initial.map((task) => [task.id, task]));
  return {
    _serviceBrand: undefined,
    docs,
    get: (_workspaceId, taskId) => Promise.resolve(docs.get(taskId)),
    list: () => Promise.resolve([...docs.values()]),
    save: (_workspaceId, task) => {
      docs.set(task.id, task);
      return Promise.resolve();
    },
    delete: (_workspaceId, taskId) => {
      docs.delete(taskId);
      return Promise.resolve();
    },
  };
}

function metadataStub(): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: () => ({ dispose: () => {} }),
    read: () => Promise.resolve({} as never),
    update: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
    setArchived: () => Promise.resolve(),
    registerAgent: () => Promise.resolve(),
  };
}

function eventStub(): IEventService {
  return {
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => {} }),
    publish: () => {},
    subscribe: () => ({ dispose: () => {} }),
  };
}

function hostEnvironmentStub(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  };
}

function workspaceFileSystemStub(dispose: () => void = () => {}): IWorkspaceFileSystem {
  return {
    _serviceBrand: undefined,
    readText: () => Promise.reject(new Error('not implemented')),
    writeText: () => Promise.reject(new Error('not implemented')),
    appendText: () => Promise.reject(new Error('not implemented')),
    readBytes: () => Promise.reject(new Error('not implemented')),
    writeBytes: () => Promise.reject(new Error('not implemented')),
    readLines: async function* () {},
    stat: () => Promise.reject(new Error('not implemented')),
    lstat: () => Promise.reject(new Error('not implemented')),
    readdir: () => Promise.reject(new Error('not implemented')),
    mkdir: () => Promise.reject(new Error('not implemented')),
    remove: () => Promise.reject(new Error('not implemented')),
    realpath: () => Promise.reject(new Error('not implemented')),
    dispose,
  };
}

function workspaceFileSystemFactoryStub(
  create: (
    context: WorkspaceFileSystemContext,
  ) => IWorkspaceFileSystem = () => workspaceFileSystemStub(),
): IWorkspaceFileSystemFactory {
  return {
    _serviceBrand: undefined,
    create,
  };
}

function sessionSnapshotStoreStub(
  fork: (
    input: ForkSnapshotInput,
  ) => Promise<ForkSnapshotResult> = () =>
    Promise.resolve({ sourceMeta: undefined, agentIds: [] }),
  deleteSnapshot: (input: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }) => Promise<void> = () => Promise.resolve(),
): ISessionSnapshotStore {
  return {
    _serviceBrand: undefined,
    fork,
    delete: deleteSnapshot,
  };
}

type MutableSessionDeletionStore = ISessionDeletionStore & {
  readonly intents: Map<string, SessionDeletionIntent>;
};

function sessionDeletionStoreStub(
  initial: readonly SessionDeletionIntent[] = [],
): MutableSessionDeletionStore {
  const intents = new Map(initial.map((intent) => [intent.sessionId, intent]));
  return {
    _serviceBrand: undefined,
    intents,
    begin: async (input) => {
      const current = intents.get(input.sessionId);
      if (current?.state === 'pending' || current?.state === 'completed') return;
      intents.set(input.sessionId, { ...input, state: 'pending' });
    },
    complete: async (input) => {
      intents.set(input.sessionId, { ...input, state: 'completed' });
    },
    clear: async (sessionId) => {
      intents.delete(sessionId);
    },
    get: async (sessionId) => intents.get(sessionId),
    list: async () => [...intents.values()],
    listPending: async () =>
      [...intents.values()].filter((intent) => intent.state === 'pending'),
  };
}

function sessionLegacyIndexStoreStub(
  append: (entry: LegacySessionIndexEntry) => Promise<void> = () => Promise.resolve(),
): ISessionLegacyIndexStore {
  return {
    _serviceBrand: undefined,
    append,
    remove: () => Promise.resolve(),
  };
}

function skillCatalogStub(): ISessionSkillCatalog {
  return {
    _serviceBrand: undefined,
    catalog: {
      getSkill: () => undefined,
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => '',
      listSkills: () => [],
      listInvocableSkills: () => [],
      getSkillRoots: () => [],
      getSkippedByPolicy: () => [],
      getModelSkillListing: () => '',
    },
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    listSkills: () => Promise.resolve([]),
    load: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

function agentProfileCatalogStub(): ISessionAgentProfileCatalog {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    get: () => undefined,
    getDefault: () => {
      throw new Error('not implemented');
    },
    list: () => [],
    load: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

function workspaceStub(): IWorkspaceService {
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    createOrTouch: (root, name) =>
      Promise.resolve({
        id: 'wd_stub',
        root,
        name: name ?? 'stub',
        createdAt: 0,
        lastOpenedAt: 0,
      }),
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
}

function projectLocalConfigStub(
  localDirs: readonly string[] = [],
): IProjectLocalConfigService {
  return {
    _serviceBrand: undefined,
    readAdditionalDirs: (workDir: string) =>
      Promise.resolve({
        projectRoot: workDir,
        configPath: `${workDir}/.kimi-code/local.toml`,
        additionalDirs: [...localDirs],
      }),
    resolveAdditionalDirs: (baseDir: string, dirs: readonly string[]) =>
      Promise.resolve(dirs.map((d) => (isAbsolute(d) ? resolve(d) : resolve(baseDir, d)))),
    appendAdditionalDir: () => Promise.reject(new Error('not implemented')),
  };
}

function persistentWorkspaceStub(): IWorkspaceService {
  const workspaces = new Map<string, Workspace>();
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve([...workspaces.values()]),
    get: (id) => Promise.resolve(workspaces.get(id)),
    createOrTouch: (root, name) => {
      const id = encodeWorkDirKey(root);
      const now = 1;
      const existing = workspaces.get(id);
      const workspace: Workspace =
        existing !== undefined
          ? { ...existing, lastOpenedAt: now }
          : {
              id,
              root,
              name: name ?? 'proj',
              createdAt: now,
              lastOpenedAt: now,
            };
      workspaces.set(id, workspace);
      return Promise.resolve(workspace);
    },
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
}

function sessionIndexStub(): ISessionIndex {
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve({ items: [], total: 0, hasMore: false }),
    get: () => Promise.resolve(undefined),
    countActive: () => Promise.resolve(0),
  };
}

function sessionIndexWithSummary(
  sessionId: string,
  workDir: string,
  workspaceId = encodeWorkDirKey(workDir),
): ISessionIndex {
  const summary = {
    id: sessionId,
    workspaceId,
    cwd: workDir,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve({ items: [summary], total: 1, hasMore: false }),
    get: (id) => Promise.resolve(id === sessionId ? summary : undefined),
    countActive: () => Promise.resolve(1),
  };
}

function appendLogStoreStub(): IAppendLogStore {
  return {
    _serviceBrand: undefined,
    append: () => {},
    read: async function* () {},
    rewrite: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    acquire: () => ({ dispose: () => {} }),
  };
}

function atomicDocumentStoreStub(): IAtomicDocumentStore {
  return {
    _serviceBrand: undefined,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    watch: () => (_listener) => ({ dispose: () => {} }),
    acquire: () => ({ dispose: () => {} }),
  };
}

function sessionToolPolicyStub(): ISessionToolPolicy {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    disabledTools: () => [],
    setDisabledTools: () => Promise.resolve(),
  };
}

function agentLifecycleStub(): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    create: () => Promise.reject(new Error('not implemented')),
    restore: () => Promise.resolve(undefined),
    fork: () => Promise.reject(new Error('not implemented')),
    get: () => undefined,
    list: () => [],
    remove: () => Promise.resolve(),
    broadcastPermissionMode: () => {},
  };
}

function sessionMcpServiceStub(
  ensureMcpReady: () => Promise<void> = () => Promise.resolve(),
): ISessionMcpService {
  return {
    _serviceBrand: undefined,
    ensureMcpReady,
    connectionManager: () => {
      throw new Error('not implemented');
    },
  };
}

function agentLifecycleWithMainStub(): IAgentLifecycleService {
  const main = {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: {
      get: () => {
        throw new Error('unexpected main agent service access');
      },
    },
    dispose: () => {},
  } as IAgentScopeHandle;
  return {
    ...agentLifecycleStub(),
    get: (id) => (id === MAIN_AGENT_ID ? main : undefined),
  };
}

function activeAgentHandle(): IAgentScopeHandle {
  return {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (token: unknown) => {
        if (token === IWireService) {
          return { flush: () => Promise.resolve() };
        }
        if (token === IAgentActivityView) {
          return {
            state: () => ({
              lifecycle: 'ready',
              turn: { turnId: 0 },
              background: [],
            }),
          };
        }
        throw new Error('unexpected service access');
      },
    },
    dispose: () => {},
  } as unknown as IAgentScopeHandle;
}

function configStub(values: Record<string, unknown> = {}): IConfigService {
  return {
    get: (domain: string) => values[domain],
    getAll: () => ({ ...values }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: () => ({ dispose: () => {} }),
  } as unknown as IConfigService;
}

function agentLifecycleCapturingPlanSpy(opts: { mainPreexists?: boolean } = {}): {
  lifecycle: IAgentLifecycleService;
  enter: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const enter = vi.fn(() => Promise.resolve());
  const planService = {
    enter,
    cancel: vi.fn(),
    clear: vi.fn(() => Promise.resolve()),
    exit: vi.fn(),
    status: vi.fn(() => Promise.resolve(null)),
  };
  const makeMain = (agentId: string): IAgentScopeHandle =>
    ({
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (token: unknown) => (token === IAgentPlanService ? planService : {}),
      },
      dispose: () => {},
    }) as IAgentScopeHandle;
  let mainHandle: IAgentScopeHandle | undefined = opts.mainPreexists
    ? makeMain(MAIN_AGENT_ID)
    : undefined;
  const create = vi.fn((args: { agentId: string }) => {
    mainHandle = makeMain(args.agentId);
    return Promise.resolve(mainHandle);
  });
  const lifecycle: IAgentLifecycleService = {
    ...agentLifecycleStub(),
    get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
    create,
  };
  return { lifecycle, enter, create };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class NoopSessionExternalHooksService implements ISessionExternalHooksService {
  declare readonly _serviceBrand: undefined;
}

let recordedSessionHookEvents: string[] = [];

class RecordingSessionExternalHooksService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionLifecycleService lifecycle: ISessionLifecycleService) {
    super();
    this._register(
      lifecycle.hooks.onDidCreateSession.register('test', async (event, next) => {
        recordedSessionHookEvents.push(`create:${event.source}:${event.sessionId}`);
        await next();
      }),
    );
    this._register(
      lifecycle.hooks.onWillCloseSession.register('test', async (event, next) => {
        recordedSessionHookEvents.push(`close:${event.reason}:${event.sessionId}`);
        await next();
      }),
    );
  }
}

describe('SessionLifecycleService', () => {
  let host: ScopedTestHost | undefined;
  let telemetryRecords: TelemetryRecord[];
  let tmpRoots: string[];

  beforeEach(() => {
    recordedSessionHookEvents = [];
    telemetryRecords = [];
    tmpRoots = [];
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionLifecycleService,
      SessionLifecycleService,
      ScopeActivation.OnDemand,
      'sessionLifecycle',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      NoopSessionExternalHooksService,
      ScopeActivation.OnScopeCreated,
      'externalHooks',
    );
    registerScopedService(
      LifecycleScope.App,
      IHostFileSystem,
      HostFileSystem,
      ScopeActivation.OnDemand,
      'hostFs',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionWorkspaceContext,
      SessionWorkspaceContextService,
      ScopeActivation.OnDemand,
      'workspaceContext',
    );
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  function build(extra: ReturnType<typeof stubPair>[] = []): ISessionLifecycleService {
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub()),
      stubPair(ISessionMetadata, metadataStub()),
      stubPair(IHostEnvironment, hostEnvironmentStub()),
      stubPair(ISessionSkillCatalog, skillCatalogStub()),
      stubPair(ISessionToolPolicy, sessionToolPolicyStub()),
      stubPair(ISessionAgentProfileCatalog, agentProfileCatalogStub()),
      stubPair(IWorkspaceService, workspaceStub()),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(IAppendLogStore, appendLogStoreStub()),
      stubPair(IAtomicDocumentStore, atomicDocumentStoreStub()),
      stubPair(ISessionDeletionStore, sessionDeletionStoreStub()),
      stubPair(ISessionLegacyIndexStore, sessionLegacyIndexStoreStub()),
      stubPair(ISessionSnapshotStore, sessionSnapshotStoreStub()),
      stubPair(IWorkspaceFileSystemFactory, workspaceFileSystemFactoryStub()),
      stubPair(IEventService, eventStub()),
      stubPair(IAgentLifecycleService, agentLifecycleStub()),
      stubPair(ISessionMcpService, sessionMcpServiceStub()),
      stubPair(IConfigService, configStub()),
      stubPair(ISessionCronService, { _serviceBrand: undefined } as unknown as ISessionCronService),
      stubPair(ISessionSecondaryModelWarningService, {
        _serviceBrand: undefined,
        getSecondaryModelWarning: () => undefined,
      } as ISessionSecondaryModelWarningService),
      stubPair(IProjectLocalConfigService, projectLocalConfigStub()),
      stubPair(ITelemetryService, recordingTelemetry(telemetryRecords)),
      stubPair(ICronTaskPersistence, cronStoreStub()),
      ...extra,
    ]);
    return host.app.accessor.get(ISessionLifecycleService);
  }

  async function makeTmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-fork-test-'));
    tmpRoots.push(root);
    return root;
  }

  it('create / get / list / close', async () => {
    const svc = build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(h.id).toBe('s1');
    expect(svc.get('s1')).toBe(h);
    expect(svc.list()).toEqual([h]);

    await svc.close('s1');
    expect(svc.get('s1')).toBeUndefined();
  });

  it('rejects an explicit id that is already live or indexed', async () => {
    const live = build();
    await live.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await expect(
      live.create({ sessionId: 's1', workDir: '/tmp/proj' }),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });

    host?.dispose();
    host = undefined;
    const indexed = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s2', '/tmp/proj', 'wd_stub')),
    ]);
    await expect(
      indexed.create({ sessionId: 's2', workDir: '/tmp/proj' }),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });
  });

  it('does not delete a pre-existing directory when create detects an id collision', async () => {
    const root = await makeTmpRoot();
    const sessionDir = join(root, 'sessions', 'wd_stub', 's1');
    const sentinel = join(sessionDir, 'sentinel.txt');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sentinel, 'keep');
    const deleteSnapshot = vi.fn(() => Promise.resolve());
    const svc = build([
      stubPair(IBootstrapService, tmpBootstrapStub(root)),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);

    await expect(
      svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });

    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });

  it('create seeds identity and materializes metadata', async () => {
    const svc = build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(h.kind).toBe(LifecycleScope.Session);
  });

  it('publishes create after the initial title and metadata are materialized', async () => {
    let data = {
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      custom: {},
    };
    const metadata = {
      ...metadataStub(),
      read: () => Promise.resolve(data),
      update: (patch: Record<string, unknown>) => {
        data = { ...data, ...patch };
        return Promise.resolve();
      },
    } as ISessionMetadata;
    const svc = build([stubPair(ISessionMetadata, metadata)]);
    let observed: unknown;
    svc.hooks.onDidCreateSession.register('test', async (event, next) => {
      observed = await event.handle.accessor.get(ISessionMetadata).read();
      await next();
    });

    await svc.create({
      sessionId: 's1',
      workDir: '/tmp/proj',
      title: 'Ready',
      metadata: { owner: 'example' },
    });

    expect(observed).toMatchObject({
      title: 'Ready',
      isCustomTitle: true,
      custom: { owner: 'example' },
    });
  });

  it('seeds one workspace filesystem per session and disposes it with that session', async () => {
    const filesystems: IWorkspaceFileSystem[] = [];
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const factory = workspaceFileSystemFactoryStub(() => {
      const dispose = vi.fn();
      const filesystem = workspaceFileSystemStub(dispose);
      filesystems.push(filesystem);
      disposals.push(dispose);
      return filesystem;
    });
    const svc = build([stubPair(IWorkspaceFileSystemFactory, factory)]);

    const first = await svc.create({ sessionId: 'first', workDir: '/tmp/proj' });
    const second = await svc.create({ sessionId: 'second', workDir: '/tmp/proj' });

    expect(first.accessor.get(IWorkspaceFileSystem)).toBe(filesystems[0]);
    expect(second.accessor.get(IWorkspaceFileSystem)).toBe(filesystems[1]);
    expect(filesystems[0]).not.toBe(filesystems[1]);

    await svc.close('first');
    expect(disposals[0]).toHaveBeenCalledOnce();
    expect(disposals[1]).not.toHaveBeenCalled();

    await svc.close('second');
    expect(disposals[1]).toHaveBeenCalledOnce();
  });

  it('uses the host workspace filesystem factory without exposing it in create options', async () => {
    const defaultCreate = vi.fn(() => workspaceFileSystemStub());
    const hostedCreate = vi.fn(() => workspaceFileSystemStub());
    const svc = build([
      stubPair(
        IWorkspaceFileSystemFactory,
        workspaceFileSystemFactoryStub(defaultCreate),
      ),
    ]);

    await svc.create(
      {
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['/tmp/extra'],
      },
      {
        workspaceFileSystemFactory:
          workspaceFileSystemFactoryStub(hostedCreate),
      },
    );

    expect(defaultCreate).not.toHaveBeenCalled();
    expect(hostedCreate).toHaveBeenCalledWith({
      sessionId: 's1',
      workDir: '/tmp/proj',
      additionalDirs: ['/tmp/extra'],
    });
  });

  it('create forwards caller-supplied MCP servers to the session MCP initial load', async () => {
    const ensureMcpReady = vi.fn(() => Promise.resolve());
    const svc = build([
      stubPair(ISessionMcpService, sessionMcpServiceStub(ensureMcpReady)),
    ]);
    const mcpServers = { docs: { transport: 'http', url: 'https://mcp.example.com' } } as const;
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj', mcpServers });
    expect(ensureMcpReady).toHaveBeenCalledWith(mcpServers);
  });

  it('create appends the session to the shared session_index.jsonl', async () => {
    const appended: unknown[] = [];
    const svc = build([
      stubPair(
        ISessionLegacyIndexStore,
        sessionLegacyIndexStoreStub((entry) => {
          appended.push(entry);
          return Promise.resolve();
        }),
      ),
    ]);

    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    // The index entry addresses the session under the registry-resolved
    // workspace id — the same id seeding the session's storage scope — not a
    // recomputed encodeWorkDirKey, so the v1 reader finds it in the bucket it
    // was materialized into.
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    expect(appended).toEqual([
      {
        sessionId: 's1',
        sessionDir: `/tmp/sessions/${workspaceId}/s1`,
        workDir: '/tmp/proj',
      },
    ]);
  });

  it('does not index and removes a fresh session when initial agent binding fails', async () => {
    const appended: unknown[] = [];
    const deleteSnapshot = vi.fn(() => Promise.resolve());
    const create = vi.fn(() => Promise.reject(new Error('Unknown agent profile')));
    const svc = build([
      stubPair(
        ISessionLegacyIndexStore,
        sessionLegacyIndexStoreStub((entry) => {
          appended.push(entry);
          return Promise.resolve();
        }),
      ),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create,
      }),
    ]);

    await expect(
      svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        mainAgentBinding: { profile: 'missing', model: 'mock' },
      }),
    ).rejects.toThrow('Unknown agent profile');

    expect(appended).toEqual([]);
    expect(svc.get('s1')).toBeUndefined();
    expect(deleteSnapshot).toHaveBeenCalledWith({
      workspaceId: 'wd_stub',
      sessionId: 's1',
    });
  });

  it('indexes the session under the registry-resolved id when the workDir is an alias spelling', async () => {
    const appended: unknown[] = [];
    const svc = build([
      stubPair(
        ISessionLegacyIndexStore,
        sessionLegacyIndexStoreStub((entry) => {
          appended.push(entry);
          return Promise.resolve();
        }),
      ),
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
        // As the real registry does after folding: the id minted for the
        // first-seen spelling is reused for the alias.
        createOrTouch: (root: string, name?: string) =>
          Promise.resolve({
            id: 'wd_first_spelling',
            root,
            name: name ?? 'proj',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
      }),
    ]);

    const handle = await svc.create({ sessionId: 's1', workDir: 'c:\\users\\foo\\proj' });

    expect(handle.accessor.get(ISessionContext).workspaceId).toBe('wd_first_spelling');
    expect(appended).toEqual([
      {
        sessionId: 's1',
        sessionDir: '/tmp/sessions/wd_first_spelling/s1',
        workDir: 'c:\\users\\foo\\proj',
      },
    ]);
  });

  it('registers the workspace during create so a cold resume can resolve the workdir', async () => {
    const workDir = '/tmp/proj';
    const workspaces = persistentWorkspaceStub();
    const sessionIndex = sessionIndexWithSummary('s1', workDir);
    const first = build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(ISessionIndex, sessionIndexStub()),
    ]);

    await first.create({ sessionId: 's1', workDir });
    await expect(workspaces.get(encodeWorkDirKey(workDir))).resolves.toMatchObject({
      root: workDir,
    });
    host?.dispose();
    host = undefined;

    const second = build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(ISessionIndex, sessionIndex),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    const resumed = await second.resume('s1');

    expect(resumed?.id).toBe('s1');
    expect(resumed?.accessor.get(ISessionContext).cwd).toBe(workDir);
  });

  it('resumes from the persisted cwd when the workspace registry entry is missing', async () => {
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume('s1');

    expect(resumed?.id).toBe('s1');
    expect(resumed?.accessor.get(ISessionContext).workspaceId).toBe(encodeWorkDirKey(workDir));
  });

  it('applies caller MCP and hosted workspace overrides during a cold resume', async () => {
    const ensureMcpReady = vi.fn(() => Promise.resolve());
    const createWorkspaceFileSystem = vi.fn(() => workspaceFileSystemStub());
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(ISessionMcpService, sessionMcpServiceStub(ensureMcpReady)),
    ]);
    const mcpServers = {
      docs: { transport: 'http', url: 'https://mcp.example.com' },
    } as const;

    await svc.resume(
      's1',
      { additionalDirs: ['/tmp/shared'], mcpServers },
      {
        workspaceFileSystemFactory:
          workspaceFileSystemFactoryStub(createWorkspaceFileSystem),
      },
    );

    expect(ensureMcpReady).toHaveBeenCalledWith(mcpServers);
    expect(createWorkspaceFileSystem).toHaveBeenCalledWith({
      sessionId: 's1',
      workDir,
      additionalDirs: ['/tmp/shared'],
    });
  });

  it('does not cache a session whose tool policy fails to initialize', async () => {
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(ISessionToolPolicy, {
        ...sessionToolPolicyStub(),
        ready: Promise.reject(new Error('invalid tool policy')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toThrow('invalid tool policy');
    expect(svc.get('s1')).toBeUndefined();
    await expect(svc.resume('s1')).rejects.toThrow('invalid tool policy');
  });

  it('disposes a cold scope when restoring its main agent fails', async () => {
    const disposeWorkspaceFileSystem = vi.fn();
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => Promise.reject(new Error('invalid main agent')),
      }),
      stubPair(
        IWorkspaceFileSystemFactory,
        workspaceFileSystemFactoryStub(() =>
          workspaceFileSystemStub(disposeWorkspaceFileSystem),
        ),
      ),
    ]);

    await expect(svc.resume('s1')).rejects.toThrow('invalid main agent');

    expect(svc.get('s1')).toBeUndefined();
    expect(disposeWorkspaceFileSystem).toHaveBeenCalledOnce();
  });

  it('resumes with the persisted cwd and indexed workspace id when the registry root is stale', async () => {
    const workDir = '/tmp/proj';
    const staleRoot = '/tmp/stale';
    const indexedWorkspaceId = 'wd_indexed';
    const workspaces: IWorkspaceService = {
      _serviceBrand: undefined,
      list: () => Promise.resolve([]),
      get: (id) =>
        Promise.resolve(
          id === indexedWorkspaceId
            ? {
                id: indexedWorkspaceId,
                root: staleRoot,
                name: 'stale',
                createdAt: 1,
                lastOpenedAt: 1,
              }
            : undefined,
        ),
        createOrTouch: (root, name) =>
        Promise.resolve({
          id: encodeWorkDirKey(root),
          root,
          name: name ?? 'proj',
          createdAt: 1,
          lastOpenedAt: 1,
        }),
      update: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
    };
    const svc = build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir, indexedWorkspaceId)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume('s1');
    const ctx = resumed?.accessor.get(ISessionContext);

    expect(ctx?.cwd).toBe(workDir);
    expect(ctx?.workspaceId).toBe(indexedWorkspaceId);
    expect(ctx?.sessionDir).toBe(`/tmp/sessions/${indexedWorkspaceId}/s1`);
  });

  it('archive flags metadata, removes agents, publishes the event, and disposes the session', async () => {
    let archived: boolean | undefined;
    const removed: string[] = [];
    const published: { type: string; payload: unknown }[] = [];
    const agentHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: () => ({}) },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = build([
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          archived = value;
          return Promise.resolve();
        },
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        _serviceBrand: undefined,
        list: () => [agentHandle],
        remove: (id: string) => {
          removed.push(id);
          return Promise.resolve();
        },
      } as unknown as IAgentLifecycleService),
      stubPair(IEventService, {
        ...eventStub(),
        publish: (event: { type: string; payload: unknown }) => published.push(event),
      }),
    ]);

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.archive('s1');

    expect(archived).toBe(true);
    expect(removed).toEqual(['main']);
    expect(published).toEqual([
      { type: 'event.session.archived', payload: { sessionId: 's1' } },
    ]);
    expect(svc.get('s1')).toBeUndefined();
  });

  it('restore clears the archived flag when the session exists on disk', async () => {
    let archived: boolean | undefined;
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          archived = value;
          return Promise.resolve();
        },
      }),
    ]);

    const restored = await svc.restore('s1');

    expect(restored?.id).toBe('s1');
    expect(archived).toBe(false);
  });

  it('hard delete drains a live session and is idempotent', async () => {
    const removed: string[] = [];
    const agent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: { get: () => ({}) },
      dispose: () => {},
    } as IAgentScopeHandle;
    const deleteSnapshot = vi.fn(() => Promise.resolve());
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [agent],
        remove: (id: string) => {
          removed.push(id);
          return Promise.resolve();
        },
      }),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    const input = { workspaceId: 'wd_stub', sessionId: 's1' };
    await svc.delete(input);
    await svc.delete(input);

    expect(removed).toEqual([MAIN_AGENT_ID]);
    expect(deleteSnapshot).toHaveBeenCalledOnce();
    expect(deleteSnapshot).toHaveBeenCalledWith(input);
    expect(svc.get('s1')).toBeUndefined();
  });

  it('hard delete can be retried after a locked snapshot store failure', async () => {
    const locked = new StorageError(
      StorageErrors.codes.STORAGE_LOCKED,
      'locked by test',
    );
    const deleteSnapshot = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(undefined);
    const svc = build([
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const input = { workspaceId: 'wd_stub', sessionId: 's1' };

    await expect(svc.delete(input)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
    });
    expect(
      errorInfo(ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED).retryable,
    ).toBe(true);
    expect(svc.get('s1')).toBeUndefined();
    await expect(svc.delete(input)).resolves.toBeUndefined();
    expect(deleteSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps a pending-delete live handle unavailable to archive and fork', async () => {
    const agent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: { get: () => ({}) },
      dispose: () => {},
    } as IAgentScopeHandle;
    const setArchived = vi.fn(() => Promise.resolve());
    const forkSnapshot = vi.fn(() =>
      Promise.resolve({ sourceMeta: undefined, agentIds: [] }),
    );
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [agent],
        remove: () => Promise.reject(new Error('drain failed')),
      }),
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived,
      }),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(forkSnapshot),
      ),
    ]);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await expect(
      svc.delete({ workspaceId: 'wd_stub', sessionId: 's1' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
    });
    expect(svc.get('s1')).toBeUndefined();

    await expect(svc.archive('s1')).resolves.toBeUndefined();
    expect(setArchived).not.toHaveBeenCalled();
    await expect(
      svc.fork({ sourceSessionId: 's1', newSessionId: 's2' }),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    expect(forkSnapshot).not.toHaveBeenCalled();
  });

  it('clears a completed tombstone before safely reusing a deleted session id', async () => {
    const deletions = sessionDeletionStoreStub();
    const svc = build([
      stubPair(ISessionDeletionStore, deletions),
    ]);
    const first = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await svc.delete({ workspaceId: 'wd_stub', sessionId: 's1' });
    expect(deletions.intents.get('s1')?.state).toBe('completed');

    const replacement = await svc.create({
      sessionId: 's1',
      workDir: '/tmp/proj',
    });

    expect(replacement).not.toBe(first);
    expect(svc.get('s1')).toBe(replacement);
    expect(deletions.intents.has('s1')).toBe(false);
  });

  it('does not reuse an id while another process still owns a pending delete', async () => {
    const deletions = sessionDeletionStoreStub();
    const svc = build([
      stubPair(ISessionDeletionStore, deletions),
    ]);
    await expect(svc.resume('missing')).resolves.toBeUndefined();
    deletions.intents.set('s1', {
      workspaceId: 'wd_stub',
      sessionId: 's1',
      state: 'pending',
    });

    await expect(
      svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });
    expect(deletions.intents.get('s1')?.state).toBe('pending');
  });

  it('does not tear down live state when the durable delete intent cannot be written', async () => {
    const ioFailure = new StorageError(
      StorageErrors.codes.STORAGE_IO_FAILED,
      'intent write failed',
    );
    const base = sessionDeletionStoreStub();
    const begin = vi.fn(() => Promise.reject(ioFailure));
    const deleteSnapshot = vi.fn(() => Promise.resolve());
    const svc = build([
      stubPair(ISessionDeletionStore, { ...base, begin }),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);
    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await expect(
      svc.delete({ workspaceId: 'wd_stub', sessionId: 's1' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED,
    });
    expect(begin).toHaveBeenCalledOnce();
    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(svc.get('s1')).toBe(handle);
    expect(errorInfo(ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED).retryable).toBe(true);
  });

  it('startup reconciliation completes a pending delete once across repeated starts', async () => {
    const deletions = sessionDeletionStoreStub([
      { workspaceId: 'wd_stub', sessionId: 's1', state: 'pending' },
    ]);
    const deleteSnapshot = vi.fn(() => Promise.resolve());
    let svc = build([
      stubPair(ISessionDeletionStore, deletions),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);

    await expect(svc.resume('missing')).resolves.toBeUndefined();
    expect(deletions.intents.get('s1')?.state).toBe('completed');
    expect(deleteSnapshot).toHaveBeenCalledOnce();

    host?.dispose();
    host = undefined;
    svc = build([
      stubPair(ISessionDeletionStore, deletions),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);

    await expect(svc.resume('missing')).resolves.toBeUndefined();
    expect(deleteSnapshot).toHaveBeenCalledOnce();
  });

  it('a new process retries startup reconciliation after a locked store failure', async () => {
    const locked = new StorageError(
      StorageErrors.codes.STORAGE_LOCKED,
      'locked by test',
    );
    const deletions = sessionDeletionStoreStub([
      { workspaceId: 'wd_stub', sessionId: 's1', state: 'pending' },
    ]);
    const deleteSnapshot = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(undefined);
    let svc = build([
      stubPair(ISessionDeletionStore, deletions),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);

    await expect(svc.resume('missing')).rejects.toMatchObject({
      code: ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
    });
    expect(deletions.intents.get('s1')?.state).toBe('pending');

    host?.dispose();
    host = undefined;
    svc = build([
      stubPair(ISessionDeletionStore, deletions),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);

    await expect(svc.resume('missing')).resolves.toBeUndefined();
    expect(deletions.intents.get('s1')?.state).toBe('completed');
    expect(deleteSnapshot).toHaveBeenCalledTimes(2);
  });

  it('a new process retries after physical deletion succeeds but completion persistence fails', async () => {
    const ioFailure = new StorageError(
      StorageErrors.codes.STORAGE_IO_FAILED,
      'completion write failed',
    );
    const base = sessionDeletionStoreStub();
    const completeBase = base.complete.bind(base);
    let failComplete = true;
    const deletions: MutableSessionDeletionStore = {
      ...base,
      complete: async (input) => {
        if (failComplete) {
          failComplete = false;
          throw ioFailure;
        }
        await completeBase(input);
      },
    };
    const deleteSnapshot = vi.fn(() => Promise.resolve());
    let svc = build([
      stubPair(ISessionDeletionStore, deletions),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await expect(
      svc.delete({ workspaceId: 'wd_stub', sessionId: 's1' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
    });
    expect(deletions.intents.get('s1')?.state).toBe('pending');
    expect(deleteSnapshot).toHaveBeenCalledOnce();

    host?.dispose();
    host = undefined;
    svc = build([
      stubPair(ISessionDeletionStore, deletions),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(undefined, deleteSnapshot),
      ),
    ]);

    await expect(svc.resume('missing')).resolves.toBeUndefined();
    expect(deletions.intents.get('s1')?.state).toBe('completed');
    expect(deleteSnapshot).toHaveBeenCalledTimes(2);
  });

  it('forks successfully even while the source has a busy agent (crash-equivalent copy)', async () => {
    const busyAgent = activeAgentHandle();
    const svc = build([
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
        get: () =>
          Promise.resolve({
            id: 'wd_stub',
            root: '/tmp/proj',
            name: 'stub',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [busyAgent],
      }),
    ]);

    await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

    // Fork never gates on activity: a mid-work copy is crash-equivalent, and
    // replay already normalizes that on restore.
    const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
    expect(target.id).toBe('dst');
  });

  it('rejects an indexed fork while the source has an active turn', async () => {
    const forkSnapshot = vi.fn(() =>
      Promise.resolve({ sourceMeta: undefined, agentIds: [] }),
    );
    const svc = build([
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
        get: () =>
          Promise.resolve({
            id: 'wd_stub',
            root: '/tmp/proj',
            name: 'stub',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [activeAgentHandle()],
      }),
      stubPair(
        ISessionSnapshotStore,
        sessionSnapshotStoreStub(forkSnapshot),
      ),
    ]);
    await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

    await expect(
      svc.fork({
        sourceSessionId: 'src',
        newSessionId: 'dst',
        userVisibleTurnIndex: 0,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.SESSION_FORK_ACTIVE_TURN,
      details: {
        sessionId: 'src',
        agentId: MAIN_AGENT_ID,
        userVisibleTurnIndex: 0,
      },
    });
    expect(forkSnapshot).not.toHaveBeenCalled();
    expect(svc.get('dst')).toBeUndefined();
  });

  it('fires onDidCreateSession with the new handle', async () => {
    const svc = build();
    let captured: { readonly sessionId: string } | undefined;
    svc.onDidCreateSession((e) => {
      captured = e;
    });
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(captured).toMatchObject({ sessionId: 's1', handle: h, source: 'startup' });
  });

  it('emits session_started with resumed: false and the bound session id on create', async () => {
    const svc = build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { sessionId: 's1', resumed: false },
    });
  });

  it('keeps telemetry session context isolated when multiple sessions emit interleaved events', async () => {
    const svc = build();
    const first = await svc.create({ sessionId: 'first', workDir: '/tmp/proj' });
    const second = await svc.create({ sessionId: 'second', workDir: '/tmp/proj' });
    telemetryRecords.length = 0;

    first.accessor.get(ITelemetryService).track('test_event', { marker: 'first-before' });
    second.accessor.get(ITelemetryService).track('test_event', { marker: 'second' });
    first.accessor.get(ITelemetryService).track('test_event', { marker: 'first-after' });

    expect(telemetryRecords).toEqual([
      {
        event: 'test_event',
        properties: { sessionId: 'first', marker: 'first-before' },
      },
      {
        event: 'test_event',
        properties: { sessionId: 'second', marker: 'second' },
      },
      {
        event: 'test_event',
        properties: { sessionId: 'first', marker: 'first-after' },
      },
    ]);
  });

  it('emits session_started with resumed: true and the bound session id on resume', async () => {
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    await svc.resume('s1');

    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { sessionId: 's1', resumed: true },
    });
  });

  it('emits session_load_failed with the bound session id and the error code when resume fails, then rethrows', async () => {
    const svc = build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new Error2(ErrorCodes.SESSION_NOT_FOUND, 'index read failed')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { sessionId: 's1', reason: ErrorCodes.SESSION_NOT_FOUND },
    });
  });

  it('emits session_load_failed with the bound session id and the error name for plain errors', async () => {
    const svc = build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new TypeError('bad index')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toBeInstanceOf(TypeError);
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { sessionId: 's1', reason: 'TypeError' },
    });
  });

  it('runs constructor-registered session lifecycle hooks before returning create and close', async () => {
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      RecordingSessionExternalHooksService,
      ScopeActivation.OnScopeCreated,
      'externalHooks',
    );
    const svc = build();

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.close('s1');

    expect(recordedSessionHookEvents).toEqual(['create:startup:s1', 'close:exit:s1']);
  });

  it('waits for MCP initialization before create returns', async () => {
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = build([
      stubPair(ISessionMcpService, sessionMcpServiceStub(() => mcpReady)),
    ]);

    let settled = false;
    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' }).then(() => {
      settled = true;
    });

    await tick();
    expect(settled).toBe(false);

    resolveMcpReady?.();
    await create;
    expect(settled).toBe(true);
  });

  it('hides a session from get/list until its resume finishes', async () => {
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(ISessionMcpService, sessionMcpServiceStub(() => mcpReady)),
    ]);

    const resumed = svc.resume('s1');
    await tick();

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);

    resolveMcpReady?.();
    const handle = await resumed;

    expect(handle?.id).toBe('s1');
    expect(svc.get('s1')).toBe(handle);
    expect(svc.list()).toEqual([handle]);
  });

  it('fires onDidCloseSession when a session is closed', async () => {
    const svc = build();
    const closed: string[] = [];
    svc.onDidCloseSession((e) => closed.push(e.sessionId));
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.close('s1');
    expect(closed).toEqual(['s1']);
  });

  it('fires onDidArchiveSession when a session is archived', async () => {
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        _serviceBrand: undefined,
        list: () => [],
        remove: () => Promise.resolve(),
      } as unknown as IAgentLifecycleService),
    ]);
    const archived: string[] = [];
    svc.onDidArchiveSession((e) => archived.push(e.sessionId));
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.archive('s1');
    expect(archived).toEqual(['s1']);
  });

  describe('additional dirs', () => {
    function dirsOf(handle: { accessor: { get<T>(id: unknown): T } }): readonly string[] {
      return (handle.accessor.get(ISessionWorkspaceContext) as ISessionWorkspaceContext)
        .additionalDirs;
    }

    it('loads project-local additional dirs into the session workspace on create', async () => {
      const svc = build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
      ]);
      const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
      expect(dirsOf(h)).toEqual(['/tmp/extra']);
    });

    it('merges caller additionalDirs and resolves relative paths against workDir', async () => {
      const svc = build();
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['../sibling', '/abs/dir'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/sibling', '/abs/dir']);
    });

    it('deduplicates project-local and caller dirs after resolving', async () => {
      const svc = build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/shared'])),
      ]);
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['../shared', '/tmp/other'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/shared', '/tmp/other']);
    });

    it('supports multiple project-local and caller additionalDirs', async () => {
      const svc = build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/a', '/tmp/b'])),
      ]);
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['/tmp/c', '/tmp/d'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/a', '/tmp/b', '/tmp/c', '/tmp/d']);
    });

    it('loads project-local dirs when resuming a closed session', async () => {
      const mainHandle = {
        id: MAIN_AGENT_ID,
        kind: LifecycleScope.Agent,
        accessor: { get: () => ({}) },
        dispose: () => {},
      } as unknown as IAgentScopeHandle;
      const summary = { id: 's1', workspaceId: 'wd_stub' } as SessionSummary;
      const svc = build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
        stubPair(IWorkspaceService, {
          ...workspaceStub(),
          get: () =>
            Promise.resolve({
              id: 'wd_stub',
              root: '/tmp/proj',
              name: 'stub',
              createdAt: 0,
              lastOpenedAt: 0,
            }),
        }),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          get: () => mainHandle,
        }),
      ]);

      const h = await svc.resume('s1');

      expect(h).toBeDefined();
      expect(dirsOf(h!)).toEqual(['/tmp/extra']);
    });

    it('fork inherits project-local dirs', async () => {
      const svc = build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
        stubPair(IWorkspaceService, {
          ...workspaceStub(),
          get: () =>
            Promise.resolve({
              id: 'wd_stub',
              root: '/tmp/proj',
              name: 'stub',
              createdAt: 0,
              lastOpenedAt: 0,
            }),
        }),
      ]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(dirsOf(target)).toEqual(['/tmp/extra']);
    });

    it('create mints a session_-prefixed lowercase id when none is supplied', async () => {
      const svc = build();
      const h = await svc.create({ workDir: '/tmp/proj' });

      expect(h.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(h.id).toBe(h.id.toLowerCase());
      expect(svc.get(h.id)).toBe(h);
    });

    it('fork mints a session_-prefixed lowercase id when newSessionId is omitted', async () => {
      const svc = build([
        stubPair(IWorkspaceService, {
          ...workspaceStub(),
          get: () =>
            Promise.resolve({
              id: 'wd_stub',
              root: '/tmp/proj',
              name: 'stub',
              createdAt: 0,
              lastOpenedAt: 0,
            }),
        }),
      ]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const target = await svc.fork({ sourceSessionId: 'src' });

      expect(target.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(target.id).toBe(target.id.toLowerCase());
      expect(target.id).not.toBe('src');
    });
  });

  describe('fork session state', () => {
    function workspaceGetStub(): ReturnType<typeof stubPair> {
      return stubPair(IWorkspaceService, {
        ...workspaceStub(),
        get: () =>
          Promise.resolve({
            id: 'wd_stub',
            root: '/tmp/proj',
            name: 'stub',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
      });
    }

    it('delegates the persisted fork to the snapshot store before publishing the target', async () => {
      const root = await makeTmpRoot();
      const forkSnapshot = vi.fn(() =>
        Promise.resolve({
          sourceMeta: { title: 'Source', agents: {} },
          agentIds: [],
        }),
      );
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(
          ISessionSnapshotStore,
          sessionSnapshotStoreStub(forkSnapshot),
        ),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      const target = await svc.fork({
        sourceSessionId: 'src',
        newSessionId: 'dst',
        userVisibleTurnIndex: 2,
      });

      expect(target.id).toBe('dst');
      expect(forkSnapshot).toHaveBeenCalledWith({
        sourceWorkspaceId: 'wd_stub',
        sourceSessionId: 'src',
        targetWorkspaceId: 'wd_stub',
        targetSessionId: 'dst',
        userVisibleTurnIndex: 2,
      });
    });

    it('loads the copied session tool policy before returning the fork', async () => {
      const root = await makeTmpRoot();
      const bootstrap = tmpBootstrapStub(root);
      const dstPolicy = join(root, 'sessions', 'wd_stub', 'dst', 'tool-policy', 'state.json');
      let readyCount = 0;
      let disabledTools: readonly string[] = [];
      const policy = {
        ...sessionToolPolicyStub(),
        get ready(): Promise<void> {
          readyCount += 1;
          if (readyCount === 1) return Promise.resolve();
          return readFile(dstPolicy, 'utf8').then((raw) => {
            disabledTools = (JSON.parse(raw) as { disabledTools: readonly string[] }).disabledTools;
          });
        },
        disabledTools: () => disabledTools,
      } satisfies ISessionToolPolicy;
      const svc = build([
        stubPair(IBootstrapService, bootstrap),
        workspaceGetStub(),
        stubPair(ISessionToolPolicy, policy),
        stubPair(
          ISessionSnapshotStore,
          sessionSnapshotStoreStub(async () => {
            await mkdir(join(dstPolicy, '..'), { recursive: true });
            await writeFile(dstPolicy, '{"disabledTools":["Skill"]}');
            return { sourceMeta: undefined, agentIds: [] };
          }),
        ),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(target.accessor.get(ISessionToolPolicy).disabledTools()).toEqual(['Skill']);
    });

    it('rolls back the target session when fork fails after materializing', async () => {
      const root = await makeTmpRoot();
      const dstDir = join(root, 'sessions', 'wd_stub', 'dst');
      const snapshots = sessionSnapshotStoreStub(
        async () => {
          await mkdir(dstDir, { recursive: true });
          return {
            sourceMeta: { agents: { main: {} } },
            agentIds: ['main'],
          };
        },
        async ({ workspaceId, sessionId }) => {
          await rm(
            join(root, 'sessions', workspaceId, sessionId),
            { recursive: true, force: true },
          );
        },
      );
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(ISessionSnapshotStore, snapshots),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );

      expect(svc.get('dst')).toBeUndefined();
      await expect(stat(dstDir)).rejects.toThrow();
      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );
    });

    it('does not delete a pre-existing target when the snapshot store rejects the fork', async () => {
      const root = await makeTmpRoot();
      const targetDir = join(root, 'sessions', 'wd_stub', 'dst');
      const sentinel = join(targetDir, 'sentinel.txt');
      await mkdir(targetDir, { recursive: true });
      await writeFile(sentinel, 'keep');
      const deleteSnapshot = vi.fn(() => Promise.resolve());
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(
          ISessionSnapshotStore,
          sessionSnapshotStoreStub(
            () =>
              Promise.reject(
                new Error2(
                  ErrorCodes.SESSION_ALREADY_EXISTS,
                  'target already exists',
                ),
              ),
            deleteSnapshot,
          ),
        ),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await expect(
        svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
      expect(deleteSnapshot).not.toHaveBeenCalled();
    });

    it('duplicates the source session cron tasks for the fork', async () => {
      const root = await makeTmpRoot();
      const cron = cronStoreStub([
        {
          id: 'task-src',
          cron: '0 9 * * *',
          prompt: 'standup',
          createdAt: 1,
          tags: { [CRON_SESSION_TAG]: 'src' },
        },
        {
          id: 'task-other',
          cron: '0 9 * * *',
          prompt: 'other',
          createdAt: 1,
          tags: { [CRON_SESSION_TAG]: 'other' },
        },
        { id: 'task-untagged', cron: '* * * * *', prompt: 'x', createdAt: 1 },
      ]);
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(ICronTaskPersistence, cron),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      const all = [...cron.docs.values()];
      expect(all).toHaveLength(4);
      const clone = all.find((task) => task.tags?.[CRON_SESSION_TAG] === 'dst');
      expect(clone).toMatchObject({ cron: '0 9 * * *', prompt: 'standup', createdAt: 1 });
      expect(clone!.id).not.toBe('task-src');
      expect(cron.docs.get('task-src')!.tags![CRON_SESSION_TAG]).toBe('src');
    });

    it('indexed fork duplicates only source cron tasks created by the selected cutoff', async () => {
      const root = await makeTmpRoot();
      const cron = cronStoreStub([
        {
          id: 'before',
          cron: '0 9 * * *',
          prompt: 'before',
          createdAt: 4,
          tags: { [CRON_SESSION_TAG]: 'src' },
        },
        {
          id: 'after',
          cron: '0 10 * * *',
          prompt: 'after',
          createdAt: 6,
          tags: { [CRON_SESSION_TAG]: 'src' },
        },
      ]);
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(ICronTaskPersistence, cron),
        stubPair(
          ISessionSnapshotStore,
          sessionSnapshotStoreStub(() =>
            Promise.resolve({
              sourceMeta: { agents: {} },
              agentIds: [],
              cutoffTime: 5,
            }),
          ),
        ),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await svc.fork({
        sourceSessionId: 'src',
        newSessionId: 'dst',
        userVisibleTurnIndex: 0,
      });

      const clones = [...cron.docs.values()].filter(
        (task) => task.tags?.[CRON_SESSION_TAG] === 'dst',
      );
      expect(clones).toHaveLength(1);
      expect(clones[0]).toMatchObject({ prompt: 'before', createdAt: 4 });
    });
  });

  describe('defaultPlanMode bootstrap', () => {
    it('enters plan mode on a fresh session when config.defaultPlanMode is true', async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(create).toHaveBeenCalledTimes(1);
      expect(enter).toHaveBeenCalledTimes(1);
    });

    it('leaves plan mode inactive when config.defaultPlanMode is absent', async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = build([
        stubPair(IConfigService, configStub({})),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });

    it('does not apply config.defaultPlanMode when resuming a session', async () => {
      const workDir = '/tmp/proj';
      const summary = { id: 's1', workspaceId: 'wd_stub', cwd: workDir } as SessionSummary;
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy({
        mainPreexists: true,
      });
      const svc = build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
        stubPair(IWorkspaceService, persistentWorkspaceStub()),
      ]);

      await svc.resume('s1');

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });
  });
});
