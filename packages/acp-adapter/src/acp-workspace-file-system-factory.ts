/**
 * `AcpWorkspaceFileSystemFactory` — an `IWorkspaceFileSystemFactory` that
 * creates `AcpWorkspaceFileSystem` instances bound to an ACP `AgentSideConnection`.
 *
 * Each factory instance is scoped to one ACP server (one `AgentSideConnection`).
 * Every `create()` call produces a fresh backend for the given session workspace,
 * with the ACP reverse-RPC channel wired for text read/write and node:fs/promises
 * for all other operations.
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
  IWorkspaceFileSystem,
  IWorkspaceFileSystemFactory,
  WorkspaceFileSystemContext,
} from '@moonshot-ai/agent-core-v2/os/interface/workspaceFileSystem';

import { AcpWorkspaceFileSystem } from './acp-workspace-file-system';

export class AcpWorkspaceFileSystemFactory implements IWorkspaceFileSystemFactory {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly conn: AgentSideConnection) {}

  create(context: WorkspaceFileSystemContext): IWorkspaceFileSystem {
    return new AcpWorkspaceFileSystem({
      conn: this.conn,
      sessionId: context.sessionId,
      workDir: context.workDir,
      additionalDirs: context.additionalDirs,
    });
  }
}
