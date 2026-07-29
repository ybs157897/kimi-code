/**
 * `workspaceFs` domain (L1) — Session-scoped workspace file system.
 *
 * Defines `IWorkspaceFileSystem` (per-session backend for user-workspace file IO)
 * and `IWorkspaceFileSystemFactory` (App-scoped factory that creates backends).
 * The default factory produces a `LocalWorkspaceFileSystem` that delegates to
 * the real `IHostFileSystem` with path confinement against the workDir and any
 * additionalDirs.
 *
 * Consumers at Session/Agent scope inject `IWorkspaceFileSystem` for workspace
 * file operations; persistence, config, and non-workspace paths keep using
 * the App-scoped `IHostFileSystem` directly.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TextDecodeErrors } from '#/_base/execEnv/decodeText';
import type { HostDirEntry, HostFileStat } from '#/os/interface/hostFileSystem';

// ---------------------------------------------------------------------------
// IWorkspaceFileSystem — per-session workspace file backend
// ---------------------------------------------------------------------------

export interface IWorkspaceFileSystem {
  readonly _serviceBrand: undefined;

  /** Read the full text content of a workspace file. */
  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;

  /** Overwrite a workspace file with text content. Creates parent directories. */
  writeText(path: string, data: string): Promise<void>;

  /** Append text to a workspace file. Creates parent directories if needed. */
  appendText(path: string, data: string): Promise<void>;

  /** Read raw bytes from a workspace file, up to `n` bytes (or the whole file). */
  readBytes(path: string, n?: number): Promise<Uint8Array>;

  /** Overwrite a workspace file with raw bytes. Creates parent directories. */
  writeBytes(path: string, data: Uint8Array): Promise<void>;

  /** Read a workspace file line-by-line as an async generator. */
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;

  /** Stat a workspace path (follows symlinks). */
  stat(path: string): Promise<HostFileStat>;

  /** Lstat a workspace path (does not follow symlinks). */
  lstat(path: string): Promise<HostFileStat>;

  /** List directory entries under a workspace path. */
  readdir(path: string): Promise<readonly HostDirEntry[]>;

  /** Create a directory under the workspace, optionally recursively. */
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;

  /** Remove a file or empty directory under the workspace. */
  remove(path: string): Promise<void>;

  /** Canonicalize a workspace path by resolving all symlinks. */
  realpath(path: string): Promise<string>;

  /** Release any resources held by this backend. Idempotent. */
  dispose(): void;
}

export const IWorkspaceFileSystem: ServiceIdentifier<IWorkspaceFileSystem> =
  createDecorator<IWorkspaceFileSystem>('workspaceFileSystem');

// ---------------------------------------------------------------------------
// IWorkspaceFileSystemFactory — App-scoped factory
// ---------------------------------------------------------------------------

export interface WorkspaceFileSystemContext {
  readonly sessionId: string;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
}

export interface IWorkspaceFileSystemFactory {
  readonly _serviceBrand: undefined;

  /**
   * Create a workspace file system backend for the given session workspace.
   * The returned backend is NOT yet registered in any DI scope — the caller
   * (sessionLifecycle) must seed it into the Session scope and wire its
   * disposal into the scope's disposal queue.
   */
  create(context: WorkspaceFileSystemContext): IWorkspaceFileSystem;
}

export const IWorkspaceFileSystemFactory: ServiceIdentifier<IWorkspaceFileSystemFactory> =
  createDecorator<IWorkspaceFileSystemFactory>('workspaceFileSystemFactory');
