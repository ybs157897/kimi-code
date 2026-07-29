/**
 * `workspaceFs` domain (L4) — `IWorkspaceFileSystemFactory` default implementation.
 *
 * App-scoped factory that creates `LocalWorkspaceFileSystem` backends, each
 * backed by the real `IHostFileSystem` and confined to a session workspace.
 * The factory itself holds no per-session state — every `create()` call
 * produces a fresh backend instance for the caller to seed into the Session
 * scope. Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type IWorkspaceFileSystem,
  IWorkspaceFileSystemFactory,
  type WorkspaceFileSystemContext,
} from '#/os/interface/workspaceFileSystem';
import { LocalWorkspaceFileSystem } from '#/session/sessionFs/localWorkspaceFs';

export class LocalWorkspaceFileSystemFactory implements IWorkspaceFileSystemFactory {
  declare readonly _serviceBrand: undefined;

  constructor(@IHostFileSystem private readonly hostFs: IHostFileSystem) {}

  create(context: WorkspaceFileSystemContext): IWorkspaceFileSystem {
    return new LocalWorkspaceFileSystem(this.hostFs, {
      workDir: context.workDir,
      additionalDirs: context.additionalDirs,
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceFileSystemFactory,
  LocalWorkspaceFileSystemFactory,
  ScopeActivation.OnScopeCreated,
  'workspaceFs',
);
