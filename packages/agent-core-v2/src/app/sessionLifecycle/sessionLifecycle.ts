/**
 * `sessionLifecycle` domain (L6) — creates and tracks sessions at the process root.
 *
 * Defines the public contract of session lifecycle: create/resume/fork
 * options, the runtime-only `SessionHostContext`, and the
 * `ISessionLifecycleService` used to create sessions (`create`), look up the
 * live ones (`get` / `list`), close or hard-delete them, archive/restore them,
 * fork them (`fork`), and fork-then-tag them as direct children (`createChild`). Announces
 * lifecycle transitions through ordered hook slots plus
 * `onDidCreateSession` / `onDidCloseSession` / `onDidArchiveSession` /
 * `onDidForkSession`. App-scoped — a single
 * process-wide instance owns the live session scope tree. Persisted
 * sessions (open or closed) are the `sessionIndex` read model; per-session
 * behaviour lives in the Session-scoped domains. The host context can replace
 * the Workspace FS factory for an in-process host without adding a callback
 * to the serializable Klient contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { Hooks } from '#/hooks';
import type { IWorkspaceFileSystemFactory } from '#/os/interface/workspaceFileSystem';

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly mainAgentBinding?: BindAgentInput;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResumeSessionOptions {
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface DeleteSessionOptions {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface SessionHostContext {
  readonly workspaceFileSystemFactory?: IWorkspaceFileSystemFactory;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly userVisibleTurnIndex?: number;
}

export interface CreateChildSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly userVisibleTurnIndex?: number;
}

export interface SessionCreatedEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly source: SessionCreateSource;
}

export interface SessionClosedEvent {
  readonly sessionId: string;
}

export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit';

export interface SessionWillCloseEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly reason: SessionCloseReason;
}

export type SessionLifecycleHooks = {
  readonly onDidCreateSession: SessionCreatedEvent;
  readonly onWillCloseSession: SessionWillCloseEvent;
};

export interface SessionArchivedEvent {
  readonly sessionId: string;
}

export interface SessionForkedEvent {
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidCreateSession: Event<SessionCreatedEvent>;
  readonly onDidCloseSession: Event<SessionClosedEvent>;
  readonly onDidArchiveSession: Event<SessionArchivedEvent>;
  readonly onDidForkSession: Event<SessionForkedEvent>;
  readonly hooks: Hooks<SessionLifecycleHooks>;
  create(
    opts: CreateSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle>;
  get(sessionId: string): ISessionScopeHandle | undefined;
  list(): readonly ISessionScopeHandle[];
  resume(
    sessionId: string,
    opts?: ResumeSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle | undefined>;
  close(sessionId: string): Promise<void>;
  delete(opts: DeleteSessionOptions): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(
    sessionId: string,
    opts?: ResumeSessionOptions,
    host?: SessionHostContext,
  ): Promise<ISessionScopeHandle | undefined>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
