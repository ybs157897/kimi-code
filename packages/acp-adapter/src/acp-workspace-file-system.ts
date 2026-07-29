/**
 * `AcpWorkspaceFileSystem` — an `IWorkspaceFileSystem` implementation that
 * routes text read/write operations through the ACP client's reverse-RPC
 * channel (`fs/readTextFile` / `fs/writeTextFile`) and falls back to the
 * local filesystem for everything else (bytes, stat, directory, etc.).
 *
 * This is the v2 equivalent of the legacy {@link AcpKaos} — it replaces the
 * `Kaos`-based text bridge with a proper Session-scoped `IWorkspaceFileSystem`
 * so ACP clients (Zed, JetBrains) can see unsaved editor buffers while all
 * other file operations (Glob/Grep, binary reads, directory listing) keep
 * their on-disk semantics.
 *
 * Path confinement follows {@link LocalWorkspaceFileSystem}'s rules:
 * relative paths are resolved against `workDir` (then `additionalDirs`);
 * absolute paths must land inside the allowed workspace tree.
 */

import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import * as fs from 'node:fs/promises';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { HostDirEntry, HostFileStat } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import type { IWorkspaceFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/workspaceFileSystem';

// Local type to avoid depending on agent-core-v2 internal exports
type TextDecodeErrors = 'strict' | 'replace' | 'ignore';

function isWithinDir(candidate: string, dir: string): boolean {
  const rel = relative(dir, candidate);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

interface AcpWorkspaceFileSystemOptions {
  readonly conn: AgentSideConnection;
  readonly sessionId: string;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
}

export class AcpWorkspaceFileSystem implements IWorkspaceFileSystem {
  declare readonly _serviceBrand: undefined;

  private readonly conn: AgentSideConnection;
  private readonly sessionId: string;
  private readonly workDir: string;
  private readonly additionalDirs: readonly string[];
  private readonly allDirs: readonly string[];

  constructor(opts: AcpWorkspaceFileSystemOptions) {
    this.conn = opts.conn;
    this.sessionId = opts.sessionId;
    this.workDir = resolve(opts.workDir);
    this.additionalDirs = opts.additionalDirs.map((d) => resolve(d));
    this.allDirs = [this.workDir, ...this.additionalDirs];
  }

  // ── path resolution ─────────────────────────────────────────────────

  private resolvePath(relOrAbs: string): string {
    if (isAbsolute(relOrAbs)) {
      const norm = normalize(relOrAbs);
      this.assertAllowed(norm);
      return norm;
    }
    const normRel = normalize(relOrAbs);
    if (normRel.startsWith('..') || isAbsolute(normRel)) {
      const abs = resolve(this.workDir, normRel);
      this.assertAllowed(abs);
      return abs;
    }
    const candidate = join(this.workDir, normRel);
    if (isWithinDir(candidate, this.workDir)) return candidate;
    for (const dir of this.additionalDirs) {
      const alt = join(dir, normRel);
      if (isWithinDir(alt, dir)) return alt;
    }
    this.assertAllowed(candidate);
    return candidate;
  }

  private assertAllowed(absPath: string): void {
    if (!this.allDirs.some((d) => isWithinDir(absPath, d))) {
      throw Object.assign(new Error(`path outside workspace: ${absPath}`), { code: 'EACCES' });
    }
  }

  // ── text operations via ACP reverse-RPC ──────────────────────────────

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    const abs = this.resolvePath(path);
    try {
      const resp = await this.conn.readTextFile({ sessionId: this.sessionId, path: abs });
      return resp.content;
    } catch {
      // Fall back to local FS when ACP reverse-RPC is unavailable or fails
      return fs.readFile(abs, { encoding: 'utf8' });
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    const abs = this.resolvePath(path);
    try {
      await this.conn.writeTextFile({ sessionId: this.sessionId, path: abs, content: data });
    } catch {
      // Fall back to local FS
      await fs.mkdir(abs.replace(/[/][^/]+$/, ''), { recursive: true }).catch(() => {});
      await fs.writeFile(abs, data, 'utf8');
    }
  }

  async appendText(path: string, data: string): Promise<void> {
    // Try ACP append: read existing, merge, write back.
    const abs = this.resolvePath(path);
    let existing = '';
    try {
      const resp = await this.conn.readTextFile({ sessionId: this.sessionId, path: abs });
      existing = resp.content;
    } catch {
      // File may not exist on the client side; fall through to local.
    }
    try {
      await this.conn.writeTextFile({ sessionId: this.sessionId, path: abs, content: existing + data });
    } catch {
      // Local fallback
      await fs.mkdir(abs.replace(/[/][^/]+$/, ''), { recursive: true }).catch(() => {});
      await fs.appendFile(abs, data, 'utf8');
    }
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    if (text.length === 0) return;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x0a /* \n */) {
        yield text.slice(start, i + 1);
        start = i + 1;
      }
    }
    if (start < text.length) yield text.slice(start);
  }

  // ── binary operations via local FS ───────────────────────────────────

  async readBytes(path: string, n?: number): Promise<Uint8Array> {
    const abs = this.resolvePath(path);
    const handle = await fs.open(abs, 'r');
    try {
      const buf = new Uint8Array(n ?? (await handle.stat()).size);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
    } finally {
      await handle.close();
    }
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const abs = this.resolvePath(path);
    await fs.mkdir(abs.replace(/[/][^/]+$/, ''), { recursive: true }).catch(() => {});
    await fs.writeFile(abs, data);
  }

  // ── metadata / directory operations via local FS ─────────────────────

  async stat(path: string): Promise<HostFileStat> {
    const abs = this.resolvePath(path);
    const s = await fs.stat(abs);
    return statToHostFileStat(s);
  }

  async lstat(path: string): Promise<HostFileStat> {
    const abs = this.resolvePath(path);
    const s = await fs.lstat(abs);
    return statToHostFileStat(s);
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    const abs = this.resolvePath(path);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    await fs.mkdir(abs, { recursive: options?.recursive ?? false });
  }

  async remove(path: string): Promise<void> {
    const abs = this.resolvePath(path);
    await fs.rm(abs, { recursive: false });
  }

  async realpath(path: string): Promise<string> {
    const abs = this.resolvePath(path);
    return fs.realpath(abs);
  }

  dispose(): void {
    // No native resources to release beyond the connection reference.
  }
}

function statToHostFileStat(s: { size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number }): HostFileStat {
  return {
    size: s.size,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    mtimeMs: s.mtimeMs,
  };
}
