/**
 * `sessionLifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree and seeding each with its identity, storage
 * addressing, telemetry view, and one owned Workspace FS backend. Runs
 * lifecycle hook slots and tears scopes down on
 * close/archive — archiving flags the session's `sessionMetadata`, removes
 * its `agentLifecycle` agents, restoring clears the archived flag, and
 * broadcasts through `event`; session start and resume failures are reported
 * through `telemetry`. Each Session scope receives a telemetry view bound to
 * its session id, while failures before a scope is available use an ephemeral
 * context view.
 * Materializes caller-provided title/custom metadata before publishing the
 * create event. Bound at App scope. Persisted
 * sessions are discovered through the `sessionIndex` read model, and workspace
 * roots are remembered through `workspace`. On create / fork the
 * session is also appended to the shared `session_index.jsonl` so v1 clients
 * (TUI, export) can discover sessions created by the v2 engine; the entry is
 * indexed under the registry-resolved workspace id — the same id seeding the
 * session's storage scope — so an alias spelling of the workDir cannot split
 * the session into a bucket v1 readers never look in. Fork flushes live Agent
 * wire journals, delegates the durable snapshot to `sessionStore`, filters
 * derived cron state at an indexed cutoff, and restores the retained target
 * Agents. Hard delete records a durable intent before tearing down live state,
 * reconciles interrupted intents at App startup, and marks completion only
 * after every persisted projection and the session directory are removed. On
 * materialize, the session's metadata, tool policy, and agent-profile catalog
 * are awaited before the handle is published — agent-file discovery is local-
 * fs and cheap, and a resumed session's first turn must see file-defined
 * agent types in the `Agent` tool description; the catalog's `ready` only
 * rejects for a fatal explicit-source error, exactly the case that should
 * fail fast, and on that failure the half-materialized handle is disposed
 * instead of poisoning the session cache (the skill catalog, by contrast, is
 * kicked fire-and-forget). The session-level services whose subscriptions
 * must exist before the first agent / turn (external hooks, cron, the
 * secondary-model startup warning) opt into `OnScopeCreated` activation.
 */

import { randomUUID } from 'node:crypto';

import { ulid } from 'ulid';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { errorInfo } from '#/_base/errors/codes';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { DEFAULT_PLAN_MODE_SECTION } from '#/agent/plan/configSection';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  PARENT_SESSION_ID_KEY,
} from '#/app/sessionIndex/sessionIndex';
import {
  ISessionDeletionStore,
  type SessionDeletionIntent,
} from '#/app/sessionStore/sessionDeletionStore';
import { ISessionLegacyIndexStore } from '#/app/sessionStore/sessionLegacyIndexStore';
import { ISessionSnapshotStore } from '#/app/sessionStore/sessionSnapshotStore';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { createHooks } from '#/hooks';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IWorkspaceFileSystem,
  IWorkspaceFileSystemFactory,
} from '#/os/interface/workspaceFileSystem';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMetaPatch,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWireService } from '#/wire/wire';

import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type DeleteSessionOptions,
  type ForkSessionOptions,
  type ResumeSessionOptions,
  type SessionHostContext,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionLifecycleHooks,
  type SessionWillCloseEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

type MaterializeSessionOptions = ResumeSessionOptions & {
  readonly sessionId: string;
  readonly workDir: string;
  readonly workspaceId?: string;
};

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  readonly hooks = createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
    'onDidCreateSession',
    'onWillCloseSession',
  ]);
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly deleting = new Map<string, Promise<void>>();
  private readonly pendingDeleteIds = new Set<string>();
  private reconciliation: Promise<void> | undefined;
  private reconciled = false;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionDeletionStore private readonly deletions: ISessionDeletionStore,
    @ISessionLegacyIndexStore private readonly legacyIndex: ISessionLegacyIndexStore,
    @ISessionSnapshotStore private readonly snapshots: ISessionSnapshotStore,
    @IWorkspaceFileSystemFactory
    private readonly workspaceFileSystems: IWorkspaceFileSystemFactory,
    @ICronTaskPersistence private readonly cronStore: ICronTaskPersistence,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IProjectLocalConfigService
    private readonly projectLocalConfig: IProjectLocalConfigService,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    void this.startReconciliation().catch(() => undefined);
  }

  private startReconciliation(): Promise<void> {
    if (this.reconciled) return Promise.resolve();
    if (this.reconciliation !== undefined) return this.reconciliation;
    let tracked!: Promise<void>;
    tracked = this.reconcilePendingDeletes()
      .then(() => {
        this.reconciled = true;
      })
      .finally(() => {
        if (this.reconciliation === tracked) this.reconciliation = undefined;
      });
    this.reconciliation = tracked;
    return tracked;
  }

  private ensureReconciled(): Promise<void> {
    return this.startReconciliation();
  }

  private async reconcilePendingDeletes(): Promise<void> {
    let pending: readonly SessionDeletionIntent[];
    try {
      pending = await this.deletions.listPending();
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
        error,
        {},
        'scan',
      );
    }
    for (const intent of pending) {
      await this.reconcileDelete(intent);
    }
  }

  private async reconcileDelete(intent: SessionDeletionIntent): Promise<void> {
    this.pendingDeleteIds.add(intent.sessionId);
    try {
      await this.snapshots.delete({
        workspaceId: intent.workspaceId,
        sessionId: intent.sessionId,
      });
      await this.deletions.complete(intent);
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
        error,
        intent,
        'reconcile',
      );
    }
  }

  private async releaseDeletionTombstone(sessionId: string): Promise<void> {
    let deletion: SessionDeletionIntent | undefined;
    try {
      deletion = await this.deletions.get(sessionId);
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED,
        error,
        { sessionId },
        'read-for-reuse',
      );
    }
    if (deletion?.state === 'pending') {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `Session "${sessionId}" is pending deletion`,
      );
    }
    if (deletion === undefined) {
      this.pendingDeleteIds.delete(sessionId);
      return;
    }
    try {
      await this.deletions.clear(sessionId);
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED,
        error,
        { sessionId },
        'clear',
      );
    }
    this.pendingDeleteIds.delete(sessionId);
  }

  async create(
    opts: CreateSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle> {
    await this.ensureReconciled();
    const sessionId = opts.sessionId ?? createSessionId();
    await this.assertCreateTargetAvailable(sessionId);
    const workspace = await this.workspaces.createOrTouch(opts.workDir);
    await this.assertSessionDirectoryAvailable(workspace.id, sessionId);
    await this.releaseDeletionTombstone(sessionId);
    let handle: ISessionScopeHandle | undefined;
    try {
      handle = await this.materializeSession(
        {
          sessionId,
          workDir: opts.workDir,
          workspaceId: workspace.id,
          additionalDirs: opts.additionalDirs,
          mcpServers: opts.mcpServers,
        },
        host,
      );
      await this.applyInitialMetadata(handle, opts);
      const main =
        opts.mainAgentBinding === undefined
          ? undefined
          : await handle.accessor.get(IAgentLifecycleService).create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
            });
      if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION)) {
        const planAgent = main ?? (await ensureMainAgent(handle));
        await planAgent.accessor.get(IAgentPlanService).enter();
      }
      // Index the session under the workspace id the registry actually resolved
      // (the same one seeding the session's storage scope), not a recomputed
      // `encodeWorkDirKey` — with root folding the two can diverge.
      await this.appendSessionIndexEntry(
        sessionId,
        opts.workDir,
        handle.accessor.get(ISessionContext).workspaceId,
      );
    } catch (error) {
      this.sessions.delete(sessionId);
      if (handle !== undefined) {
        await this.drainAgents(handle).catch(() => {});
        handle.dispose();
      }
      await this.snapshots
        .delete({ workspaceId: workspace.id, sessionId })
        .catch(() => {});
      throw error;
    }
    if (handle === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_INIT_FAILED,
        `Session "${sessionId}" was not materialized`,
      );
    }
    this.sessions.set(sessionId, handle);
    await this.announceCreated({ sessionId, handle, source: 'startup' });
    return handle;
  }

  private async materializeSession(
    opts: MaterializeSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle> {
    const workspace = await this.workspaces.createOrTouch(opts.workDir);
    const workspaceId = opts.workspaceId ?? workspace.id;
    const sessionScope = this.bootstrap.sessionScope(workspaceId, opts.sessionId);
    const sessionDir = this.bootstrap.sessionDir(workspaceId, opts.sessionId);
    const metaScope = sessionScope;
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
      cwd: opts.workDir,
      scope: (subKey?: string): string =>
        subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
    };
    const localWorkspaceDirs = await this.projectLocalConfig.readAdditionalDirs(opts.workDir);
    const callerAdditionalDirs = await this.projectLocalConfig.resolveAdditionalDirs(
      opts.workDir,
      opts.additionalDirs ?? [],
    );
    const additionalDirs = [
      ...new Set([...localWorkspaceDirs.additionalDirs, ...callerAdditionalDirs]),
    ];
    await this.hostEnv.ready;
    const workspaceFileSystem = (
      host?.workspaceFileSystemFactory ?? this.workspaceFileSystems
    ).create({
      sessionId: opts.sessionId,
      workDir: opts.workDir,
      additionalDirs,
    });
    let handle: ISessionScopeHandle | undefined;
    try {
      const child = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Session,
        opts.sessionId,
        {
          extra: [
            ...sessionContextSeed(ctx),
            [ITelemetryService, this.telemetry.withContext({ sessionId: opts.sessionId })],
            [IWorkspaceFileSystem, workspaceFileSystem],
          ],
        },
      ) as ISessionScopeHandle;
      handle = ownWorkspaceFileSystem(child, workspaceFileSystem);
    } catch (error) {
      workspaceFileSystem.dispose();
      throw error;
    }
    if (additionalDirs.length > 0) {
      handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
    }
    try {
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      void handle.accessor.get(ISessionSkillCatalog).ready;
      await handle.accessor.get(ISessionAgentProfileCatalog).ready;
      await handle.accessor.get(ISessionMcpService).ensureMcpReady(opts.mcpServers);
    } catch (error) {
      handle.dispose();
      throw error;
    }
    return handle;
  }

  private async applyInitialMetadata(
    handle: ISessionScopeHandle,
    opts: CreateSessionOptions,
  ): Promise<void> {
    if (opts.title === undefined && opts.metadata === undefined) return;
    let patch: SessionMetaPatch;
    if (opts.title === undefined) {
      patch = { custom: opts.metadata };
    } else if (opts.metadata === undefined) {
      patch = { title: opts.title, isCustomTitle: true };
    } else {
      patch = {
        title: opts.title,
        isCustomTitle: true,
        custom: opts.metadata,
      };
    }
    await handle.accessor.get(ISessionMetadata).update(patch);
  }

  private async assertCreateTargetAvailable(sessionId: string): Promise<void> {
    if (
      this.sessions.has(sessionId) ||
      this.resuming.has(sessionId) ||
      this.deleting.has(sessionId) ||
      (await this.index.get(sessionId)) !== undefined
    ) {
      throw new Error2(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `Session "${sessionId}" already exists`,
      );
    }
  }

  private async assertSessionDirectoryAvailable(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    const sessionDir = this.bootstrap.sessionDir(workspaceId, sessionId);
    try {
      await this.hostFs.stat(sessionDir);
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.OS_FS_NOT_FOUND) return;
      throw error;
    }
    throw new Error2(
      ErrorCodes.SESSION_ALREADY_EXISTS,
      `Session "${sessionId}" already exists`,
    );
  }

  /**
   * Append one entry to the v1-compatible `session_index.jsonl`. `workspaceId`
   * must be the SAME id the session was materialized with (registry-resolved,
   * possibly folded from an alias spelling) — recomputing
   * `encodeWorkDirKey(workDir)` here could mint a different bucket and orphan
   * the session for v1 readers.
   */
  private async appendSessionIndexEntry(
    sessionId: string,
    workDir: string,
    workspaceId: string,
  ): Promise<void> {
    const sessionDir = this.bootstrap.sessionDir(workspaceId, sessionId);
    await this.legacyIndex.append({
      sessionId,
      sessionDir,
      workDir,
    });
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this.hooks.onDidCreateSession.run(event);
    this._onDidCreateSession.fire(event);
    event.handle.accessor
      .get(ITelemetryService)
      .track2('session_started', { resumed: event.source === 'resume' });
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (
      this.resuming.has(sessionId) ||
      this.deleting.has(sessionId) ||
      this.pendingDeleteIds.has(sessionId)
    ) {
      return undefined;
    }
    return this.sessions.get(sessionId);
  }

  resume(
    sessionId: string,
    opts: ResumeSessionOptions = {},
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle | undefined> {
    const deleting = this.deleting.get(sessionId);
    if (deleting !== undefined) return deleting.then(() => undefined);
    if (this.pendingDeleteIds.has(sessionId)) return Promise.resolve(undefined);
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const promise = this.resumeAfterReconciliation(sessionId, opts, host)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async resumeAfterReconciliation(
    sessionId: string,
    opts: ResumeSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle | undefined> {
    await this.ensureReconciled();
    return this.doResume(sessionId, opts, host);
  }

  private async doResume(
    sessionId: string,
    opts: ResumeSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace =
      summary.cwd === undefined ? await this.workspaces.get(summary.workspaceId) : undefined;
    const workDir = summary.cwd ?? workspace?.root;
    if (workDir === undefined) return undefined;

    const handle = await this.materializeSession(
      {
        sessionId,
        workDir,
        workspaceId: summary.workspaceId,
        additionalDirs: opts.additionalDirs,
        mcpServers: opts.mcpServers,
      },
      host,
    );
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      if (agents.get(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
    } catch (error) {
      await this.drainAgents(handle).catch(() => {});
      handle.dispose();
      throw error;
    }
    this.sessions.set(sessionId, handle);
    await this.announceCreated({ sessionId, handle, source: 'resume' });
    return handle;
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const [id, handle] of this.sessions) {
      if (
        !this.resuming.has(id) &&
        !this.deleting.has(id) &&
        !this.pendingDeleteIds.has(id)
      ) {
        ready.push(handle);
      }
    }
    return ready;
  }

  async close(sessionId: string): Promise<void> {
    await this.ensureReconciled();
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    await this.drainAgents(handle);
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidCloseSession.fire({ sessionId });
  }

  delete(opts: DeleteSessionOptions): Promise<void> {
    const inflight = this.deleting.get(opts.sessionId);
    if (inflight !== undefined) return inflight;
    const promise = this.deleteAfterReconciliation(opts).finally(() => {
      this.deleting.delete(opts.sessionId);
    });
    this.deleting.set(opts.sessionId, promise);
    return promise;
  }

  private async deleteAfterReconciliation(opts: DeleteSessionOptions): Promise<void> {
    await this.ensureReconciled();
    await this.doDelete(opts);
  }

  private async doDelete(opts: DeleteSessionOptions): Promise<void> {
    const resuming = this.resuming.get(opts.sessionId);
    if (resuming !== undefined) await resuming;
    const live = this.sessions.get(opts.sessionId);
    let deletion: SessionDeletionIntent | undefined;
    try {
      deletion = await this.deletions.get(opts.sessionId);
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED,
        error,
        opts,
        'read-intent',
      );
    }
    const summary = await this.index.get(opts.sessionId);
    const workspaceId =
      live?.accessor.get(ISessionContext).workspaceId ??
      summary?.workspaceId ??
      deletion?.workspaceId;
    if (workspaceId !== undefined && workspaceId !== opts.workspaceId) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${opts.sessionId}" does not exist in workspace "${opts.workspaceId}"`,
      );
    }
    if (deletion?.state === 'completed') {
      this.pendingDeleteIds.add(opts.sessionId);
      return;
    }
    const input = {
      workspaceId: workspaceId ?? opts.workspaceId,
      sessionId: opts.sessionId,
    };
    try {
      await this.deletions.begin(input);
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED,
        error,
        input,
        'write-intent',
      );
    }
    this.pendingDeleteIds.add(opts.sessionId);
    try {
      await this.close(opts.sessionId);
      await this.reconcileDelete({ ...input, state: 'pending' });
    } catch (error) {
      throw deletePersistenceError(
        ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED,
        error,
        input,
        'delete',
      );
    }
  }

  async archive(sessionId: string): Promise<void> {
    await this.ensureReconciled();
    if (this.deleting.has(sessionId) || this.pendingDeleteIds.has(sessionId)) return;
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await meta.setArchived(true);
    await this.drainAgents(handle);
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId },
    });
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidArchiveSession.fire({ sessionId });
  }

  async restore(
    sessionId: string,
    opts: ResumeSessionOptions = {},
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle | undefined> {
    const handle = await this.resume(sessionId, opts, host);
    if (handle === undefined) return undefined;
    await handle.accessor.get(ISessionMetadata).setArchived(false);
    return handle;
  }

  private async announceWillClose(event: SessionWillCloseEvent): Promise<void> {
    await this.hooks.onWillCloseSession.run(event);
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
    }
  }

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    await this.ensureReconciled();
    const sourceId = opts.sourceSessionId;
    if (this.deleting.has(sourceId) || this.pendingDeleteIds.has(sourceId)) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (sourceHandle === undefined && indexSummary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    const workspaceId =
      sourceHandle !== undefined
        ? sourceHandle.accessor.get(ISessionContext).workspaceId
        : indexSummary!.workspaceId;
    this.assertIndexedForkSourceIdle(
      sourceId,
      sourceHandle,
      opts.userVisibleTurnIndex,
    );
    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let snapshotOwned = false;
    try {
      const workspace = await this.workspaces.get(workspaceId);
      if (workspace === undefined) {
        throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${workspaceId} does not exist`);
      }
      targetId = opts.newSessionId ?? createSessionId();
      await this.assertCreateTargetAvailable(targetId);
      await this.assertSessionDirectoryAvailable(workspaceId, targetId);
      await this.releaseDeletionTombstone(targetId);
      await this.flushSessionAgents(sourceHandle);
      const snapshot = await this.snapshots.fork({
        sourceWorkspaceId: workspaceId,
        sourceSessionId: sourceId,
        targetWorkspaceId: workspaceId,
        targetSessionId: targetId,
        userVisibleTurnIndex: opts.userVisibleTurnIndex,
      });
      snapshotOwned = true;
      target = await this.materializeSession({
        sessionId: targetId,
        workDir: workspace.root,
        workspaceId,
      });
      const targetCtx = target.accessor.get(ISessionContext);
      const targetMeta = target.accessor.get(ISessionMetadata);
      const sourceMeta = snapshot.sourceMeta;
      const sourceAgents = snapshotAgents(sourceMeta?.agents);
      const sourceTitle =
        sourceMeta?.title === undefined || sourceMeta.title === ''
          ? sourceId
          : sourceMeta.title;
      const title = opts.title ?? `Fork: ${sourceTitle}`;
      await targetMeta.update({
        title,
        isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
        forkedFrom: sourceId,
        archived: false,
        lastPrompt:
          opts.userVisibleTurnIndex === undefined
            ? sourceMeta?.lastPrompt
            : snapshot.lastPrompt,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
      });
      await this.duplicateCronTasks(
        workspaceId,
        sourceId,
        targetId,
        snapshot.cutoffTime,
      );
      for (const agentId of snapshot.agentIds) {
        const sourceAgent = sourceAgents[agentId];
        if (sourceAgent === undefined) continue;
        await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        });
      }

      await this.appendSessionIndexEntry(targetId, workspace.root, targetCtx.workspaceId);
      this.sessions.set(targetId, target);
      this._onDidForkSession.fire({
        sourceSessionId: sourceId,
        sessionId: targetId,
        handle: target,
      });
      await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
      return target;
    } catch (error) {
      if (targetId !== undefined) {
        this.sessions.delete(targetId);
      }
      if (target !== undefined) {
        try {
          await this.drainAgents(target);
          target.dispose();
        } catch {}
      }
      if (targetId !== undefined && snapshotOwned) {
        await this.snapshots
          .delete({ workspaceId, sessionId: targetId })
          .catch(() => {});
      }
      throw error;
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    const metadata = {
      ...opts.metadata,
      [PARENT_SESSION_ID_KEY]: opts.sourceSessionId,
      [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
    };
    return this.fork({
      sourceSessionId: opts.sourceSessionId,
      newSessionId: opts.newSessionId,
      title,
      metadata,
      userVisibleTurnIndex: opts.userVisibleTurnIndex,
    });
  }

  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.sessions.get(sourceId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  private async flushSessionAgents(handle: ISessionScopeHandle | undefined): Promise<void> {
    if (handle === undefined) return;
    for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
      await agent.accessor.get(IWireService).flush();
    }
  }

  private assertIndexedForkSourceIdle(
    sourceId: string,
    handle: ISessionScopeHandle | undefined,
    userVisibleTurnIndex: number | undefined,
  ): void {
    if (handle === undefined || userVisibleTurnIndex === undefined) return;
    for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
      if (agent.accessor.get(IAgentActivityView).state().turn === undefined) continue;
      throw new Error2(
        ErrorCodes.SESSION_FORK_ACTIVE_TURN,
        `Cannot fork session "${sourceId}" at a turn index while agent "${agent.id}" has an active turn`,
        { details: { sessionId: sourceId, agentId: agent.id, userVisibleTurnIndex } },
      );
    }
  }

  private async duplicateCronTasks(
    workspaceId: string,
    sourceId: string,
    targetId: string,
    cutoffTime?: number,
  ): Promise<void> {
    const tasks = await this.cronStore.list({ workspaceId });
    for (const task of tasks) {
      if (task.tags?.[CRON_SESSION_TAG] !== sourceId) continue;
      if (cutoffTime !== undefined && task.createdAt > cutoffTime) continue;
      const clone: CronTask = {
        ...task,
        id: ulid(),
        tags: { ...task.tags, [CRON_SESSION_TAG]: targetId },
      };
      await this.cronStore.save(workspaceId, clone);
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLifecycleService,
  SessionLifecycleService,
  ScopeActivation.OnScopeCreated,
  'sessionLifecycle',
);

type DeletePersistenceErrorCode =
  | typeof ErrorCodes.SESSION_STORE_DELETE_INTENT_FAILED
  | typeof ErrorCodes.SESSION_STORE_DELETE_RECONCILIATION_FAILED;

function deletePersistenceError(
  code: DeletePersistenceErrorCode,
  error: unknown,
  context: { readonly workspaceId?: string; readonly sessionId?: string },
  phase: string,
): Error2 {
  if (isError2(error)) {
    if (error.code === code || !errorInfo(error.code).retryable) return error;
  }
  return new Error2(code, 'Session deletion could not be completed and can be retried', {
    cause: error,
    details: {
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      phase,
      causeCode: isError2(error) ? error.code : undefined,
    },
  });
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function ownWorkspaceFileSystem(
  handle: ISessionScopeHandle,
  workspaceFileSystem: IWorkspaceFileSystem,
): ISessionScopeHandle {
  let disposed = false;
  return {
    ...handle,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        handle.dispose();
      } finally {
        workspaceFileSystem.dispose();
      }
    },
  };
}

function snapshotAgents(
  agents: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, AgentMeta>> {
  if (agents === undefined) return {};
  const result: Record<string, AgentMeta> = {};
  for (const [agentId, value] of Object.entries(agents)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    result[agentId] = value as AgentMeta;
  }
  return result;
}

function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...withoutGoal(source), ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
