/**
 * `sessionFs` domain (L2) — default local workspace file system backend.
 *
 * Implements `IWorkspaceFileSystem` by delegating to the App-scoped
 * `IHostFileSystem` and confining every path to the session workspace
 * (`workDir` + `additionalDirs`). Relative paths are resolved against the
 * workDir first, then the additionalDirs; absolute paths must land inside
 * the allowed tree.
 *
 * Symlink confinement is verified by resolving the longest existing prefix
 * through `IHostFileSystem.realpath` (matching `SessionFsService`'s pattern):
 * a symlink inside the workspace must not steer fs actions to files outside it.
 *
 * This is NOT a DI service — it is constructed by `IWorkspaceFileSystemFactory`
 * and takes plain constructor arguments. The factory seeds the instance into
 * the Session scope, which manages its disposal.
 */

import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import type { TextDecodeErrors } from '#/_base/execEnv/decodeText';
import type { HostDirEntry, HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { OsFsErrors, toHostFsError } from '#/os/interface/hostFsErrors';
import type { IWorkspaceFileSystem } from '#/os/interface/workspaceFileSystem';

function isWithinDir(candidate: string, dir: string): boolean {
  const rel = relative(dir, candidate);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

export interface LocalWorkspaceFsOptions {
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
}

export class LocalWorkspaceFileSystem extends Disposable implements IWorkspaceFileSystem {
  declare readonly _serviceBrand: undefined;

  private readonly workDir: string;
  private readonly additionalDirs: readonly string[];
  private readonly allDirs: readonly string[];

  constructor(
    private readonly hostFs: IHostFileSystem,
    opts: LocalWorkspaceFsOptions,
  ) {
    super();
    this.workDir = resolve(opts.workDir);
    this.additionalDirs = opts.additionalDirs.map((d) => resolve(d));
    this.allDirs = [this.workDir, ...this.additionalDirs];
  }

  // ---- path resolution ----------------------------------------------------

  /**
   * Resolve a relative path to an absolute path inside the workspace.
   * Absolute paths are validated but returned as-is after normalization.
   */
  private resolvePath(relOrAbs: string): string {
    if (isAbsolute(relOrAbs)) {
      const norm = normalize(relOrAbs);
      this.assertAllowed(norm, 'read');
      return norm;
    }
    // Try workDir first, then additionalDirs.
    const normRel = normalize(relOrAbs);
    if (normRel.startsWith('..') || isAbsolute(normRel)) {
      const abs = resolve(this.workDir, normRel);
      this.assertAllowed(abs, 'read');
      return abs;
    }
    const candidate = join(this.workDir, normRel);
    if (isWithinDir(candidate, this.workDir)) {
      return candidate;
    }
    for (const dir of this.additionalDirs) {
      const alt = join(dir, normRel);
      if (isWithinDir(alt, dir)) {
        return alt;
      }
    }
    // Default to workDir-resolved and let confinement check reject it.
    this.assertAllowed(candidate, 'read');
    return candidate;
  }

  /**
   * Assert that an absolute path is within the allowed workspace.
   * Uses isWithin check, then realpath-based symlink confinement.
   */
  private assertAllowed(absPath: string, _op: string): void {
    if (!this.allDirs.some((d) => isWithinDir(absPath, d))) {
      throw toHostFsError(
        Object.assign(new Error(`path outside workspace: ${absPath}`), {
          code: 'EACCES',
        }),
        { path: absPath, op: 'assert' },
      );
    }
  }

  /**
   * Symlink-aware confinement: resolve the longest existing prefix through
   * realpath, then re-check that it still lands inside the workspace.
   */
  private async confine(absPath: string): Promise<string> {
    // Walk up the path to find the longest existing prefix.
    const parts = absPath.split(sep);
    while (parts.length > 1) {
      const prefix = parts.join(sep);
      try {
        const real = await this.hostFs.realpath(prefix);
        const tail = absPath.slice(prefix.length);
        const resolvedPath = tail ? join(real, tail) : real;
        if (!this.allDirs.some((d) => isWithinDir(resolvedPath, d))) {
          throw toHostFsError(
            Object.assign(new Error(`symlink escapes workspace: ${absPath}`), {
              code: 'EACCES',
            }),
            { path: absPath, op: 'confine' },
          );
        }
        return resolvedPath;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        // Only a missing prefix is eligible for upward traversal. Permission,
        // I/O, and the explicit symlink-escape error must reach the caller.
      }
      parts.pop();
    }
    // Fall through: path is entirely non-existent. Validate lexically.
    if (!this.allDirs.some((d) => isWithinDir(absPath, d))) {
      throw toHostFsError(
        Object.assign(new Error(`path outside workspace: ${absPath}`), {
          code: 'EACCES',
        }),
        { path: absPath, op: 'confine' },
      );
    }
    return absPath;
  }

  // ---- IWorkspaceFileSystem ------------------------------------------------

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.readText(abs, options);
  }

  async writeText(path: string, data: string): Promise<void> {
    const abs = this.resolvePath(path);
    const confined = await this.confine(abs);
    await this.hostFs.mkdir(confined.replace(/[/][^/]+$/, ''), { recursive: true }).catch(() => {
      // Parent may already exist; ignore.
    });
    return this.hostFs.writeText(confined, data);
  }

  async appendText(path: string, data: string): Promise<void> {
    const abs = this.resolvePath(path);
    const confined = await this.confine(abs);
    return this.hostFs.appendText(confined, data);
  }

  async readBytes(path: string, n?: number): Promise<Uint8Array> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.readBytes(abs, n);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const abs = this.resolvePath(path);
    const confined = await this.confine(abs);
    await this.hostFs.mkdir(confined.replace(/[/][^/]+$/, ''), { recursive: true }).catch(() => {
      // Parent may already exist; ignore.
    });
    return this.hostFs.writeBytes(confined, data);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    const abs = await this.confine(this.resolvePath(path));
    yield* this.hostFs.readLines(abs, options);
  }

  async stat(path: string): Promise<HostFileStat> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.stat(abs);
  }

  async lstat(path: string): Promise<HostFileStat> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.lstat(abs);
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.readdir(abs);
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    const confined = await this.confine(abs);
    return this.hostFs.mkdir(confined, options);
  }

  async remove(path: string): Promise<void> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.remove(abs);
  }

  async realpath(path: string): Promise<string> {
    const abs = await this.confine(this.resolvePath(path));
    return this.hostFs.realpath(abs);
  }

  override dispose(): void {
    // LocalWorkspaceFileSystem holds no native resources beyond the hostFs
    // reference; disposal is handled by the scope that owns it.
    super.dispose();
  }
}
