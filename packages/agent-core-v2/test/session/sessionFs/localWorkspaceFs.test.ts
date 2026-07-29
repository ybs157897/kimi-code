/**
 * Tests for `LocalWorkspaceFileSystem` (default backend) and
 * `LocalWorkspaceFileSystemFactory` (App-scoped factory).
 *
 * Covers:
 * - Basic read/write/append/readBytes/readLines/stat/lstat/readdir/mkdir/remove/realpath
 * - Workspace confinement (rejects paths outside workDir + additionalDirs)
 * - Two-backend isolation (different workDirs)
 * - Disposal idempotency
 * - Factory creation and DI resolution
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceFileSystemFactory } from '#/os/interface/workspaceFileSystem';
import { LocalWorkspaceFileSystem } from '#/session/sessionFs/localWorkspaceFs';
import { LocalWorkspaceFileSystemFactory } from '#/app/workspaceFs/localWorkspaceFileSystemFactoryService';

// ============================================================================
// Helpers
// ============================================================================

interface FakeFsOptions {
  files: Record<string, string>;
  dirs?: string[];
  symlinks?: Record<string, string>;
}

function makeFakeHostFs(opts: FakeFsOptions): IHostFileSystem {
  const fileMap = new Map<string, string>(Object.entries(opts.files));
  const dirSet = new Set<string>(opts.dirs ?? []);

  // Collect implicit directories from file paths
  for (const path of fileMap.keys()) {
    let p = path;
    while (true) {
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (parent === '' || parent === p) break;
      dirSet.add(parent);
      p = parent;
    }
  }

  const enoent = (p: string): Error & { code: string } => {
    const err = new Error(`ENOENT: ${p}`) as Error & { code: string };
    err.code = 'ENOENT';
    return err;
  };

  return {
    _serviceBrand: undefined,

    readText: async (p) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      return c;
    },

    writeText: async (p, data) => {
      fileMap.set(p, data);
    },

    appendText: async (p, data) => {
      const existing = fileMap.get(p) ?? '';
      fileMap.set(p, existing + data);
    },

    readBytes: async (p, n) => {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      const buf = Buffer.from(c);
      return buf.subarray(0, n ?? buf.length);
    },

    writeBytes: async (p, data) => {
      fileMap.set(p, Buffer.from(data).toString('utf-8'));
    },

    readLines: async function* (p) {
      const c = fileMap.get(p);
      if (c === undefined) throw enoent(p);
      for (const line of c.split('\n')) {
        yield line;
      }
    },

    createExclusive: async () => false,

    stat: async (p) => {
      if (fileMap.has(p)) {
        return { isFile: true, isDirectory: false, size: fileMap.get(p)!.length };
      }
      if (dirSet.has(p)) {
        return { isFile: false, isDirectory: true, size: 0 };
      }
      throw enoent(p);
    },

    lstat: async (p) => {
      if (fileMap.has(p)) {
        return { isFile: true, isDirectory: false, size: fileMap.get(p)!.length };
      }
      if (dirSet.has(p)) {
        return { isFile: false, isDirectory: true, size: 0 };
      }
      throw enoent(p);
    },

    readdir: async (p) => {
      if (!dirSet.has(p) && p !== '/') throw enoent(p);
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const seen = new Map<string, { name: string; isFile: boolean; isDirectory: boolean }>();
      for (const f of fileMap.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const name = rest.split('/')[0];
        if (!name || name.length === 0) continue;
        if (!seen.has(name)) {
          seen.set(name, { name, isFile: !rest.includes('/'), isDirectory: rest.includes('/') });
        }
      }
      for (const d of dirSet) {
        if (!d.startsWith(prefix) || d === p) continue;
        const rest = d.slice(prefix.length);
        const name = rest.split('/')[0];
        if (!name || name.length === 0) continue;
        if (!seen.has(name)) {
          seen.set(name, { name, isFile: false, isDirectory: true });
        }
      }
      return [...seen.values()];
    },

    mkdir: async (p, options) => {
      if (options?.recursive) {
        dirSet.add(p);
        return;
      }
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (parent && !dirSet.has(parent)) throw enoent(parent);
      dirSet.add(p);
    },

    remove: async (p) => {
      fileMap.delete(p);
      dirSet.delete(p);
    },

    realpath: async (p) => {
      if (fileMap.has(p) || dirSet.has(p)) return p;
      throw enoent(p);
    },
  };
}

// ============================================================================
// LocalWorkspaceFileSystem unit tests
// ============================================================================

describe('LocalWorkspaceFileSystem', () => {
  let hostFs: IHostFileSystem;
  const workDir = '/ws';

  beforeEach(() => {
    hostFs = makeFakeHostFs({
      files: {
        '/ws/readme.md': 'hello world',
        '/ws/src/app.ts': 'const x = 1;',
        '/ws/empty.txt': '',
      },
      dirs: ['/ws', '/ws/src', '/ws/sub'],
    });
  });

  function makeFs(extraDirs: string[] = []): LocalWorkspaceFileSystem {
    return new LocalWorkspaceFileSystem(hostFs, {
      workDir,
      additionalDirs: extraDirs,
    });
  }

  // ---- basic operations ----------------------------------------------------

  describe('readText', () => {
    it('reads a file by relative path', async () => {
      const fs = makeFs();
      const content = await fs.readText('readme.md');
      expect(content).toBe('hello world');
    });

    it('reads a file by absolute path within workspace', async () => {
      const fs = makeFs();
      const content = await fs.readText('/ws/src/app.ts');
      expect(content).toBe('const x = 1;');
    });

    it('rejects path outside workspace', async () => {
      const fs = makeFs();
      await expect(fs.readText('/etc/passwd')).rejects.toThrow();
    });
  });

  describe('writeText', () => {
    it('writes a file and reads it back', async () => {
      const fs = makeFs();
      await fs.writeText('new.txt', 'new content');
      const content = await fs.readText('new.txt');
      expect(content).toBe('new content');
    });

    it('rejects write outside workspace', async () => {
      const fs = makeFs();
      await expect(fs.writeText('/etc/hosts', 'bad')).rejects.toThrow();
    });
  });

  describe('appendText', () => {
    it('appends to an existing file', async () => {
      const fs = makeFs();
      await fs.appendText('readme.md', ' more');
      const content = await fs.readText('readme.md');
      expect(content).toBe('hello world more');
    });
  });

  describe('readBytes', () => {
    it('reads bytes from a file', async () => {
      const fs = makeFs();
      const bytes = await fs.readBytes('readme.md', 5);
      expect(Buffer.from(bytes).toString()).toBe('hello');
    });
  });

  describe('readLines', () => {
    it('yields lines from a file', async () => {
      const fs = makeFs();
      const lines: string[] = [];
      for await (const line of fs.readLines('readme.md')) {
        lines.push(line);
      }
      expect(lines).toEqual(['hello world']);
    });
  });

  describe('stat', () => {
    it('stats a file', async () => {
      const fs = makeFs();
      const s = await fs.stat('readme.md');
      expect(s.isFile).toBe(true);
      expect(s.size).toBe(11);
    });

    it('stats a directory', async () => {
      const fs = makeFs();
      const s = await fs.stat('src');
      expect(s.isDirectory).toBe(true);
    });
  });

  describe('lstat', () => {
    it('lstats a file', async () => {
      const fs = makeFs();
      const s = await fs.lstat('readme.md');
      expect(s.isFile).toBe(true);
    });
  });

  describe('readdir', () => {
    it('lists directory entries', async () => {
      const fs = makeFs();
      const entries = await fs.readdir('/ws');
      const names = entries.map((e) => e.name);
      expect(names).toContain('readme.md');
      expect(names).toContain('src');
    });
  });

  describe('mkdir', () => {
    it('creates a directory recursively', async () => {
      const fs = makeFs();
      await fs.mkdir('a/b/c', { recursive: true });
      const s = await fs.stat('a/b/c');
      expect(s.isDirectory).toBe(true);
    });
  });

  describe('remove', () => {
    it('removes a file', async () => {
      const fs = makeFs();
      await fs.remove('readme.md');
      await expect(fs.stat('readme.md')).rejects.toThrow();
    });
  });

  describe('realpath', () => {
    it('canonicalizes a path', async () => {
      const fs = makeFs();
      const rp = await fs.realpath('/ws/src/app.ts');
      expect(rp).toBe('/ws/src/app.ts');
    });
  });

  // ---- confinement ---------------------------------------------------------

  describe('confinement', () => {
    it('rejects absolute path outside workDir', async () => {
      const fs = makeFs();
      await expect(fs.readText('/outside/file.txt')).rejects.toThrow();
    });

    it('rejects relative path that escapes via ..', async () => {
      const fs = makeFs();
      await expect(fs.readText('../../../etc/passwd')).rejects.toThrow();
    });

    it('allows path inside additionalDirs', async () => {
      const extraHostFs = makeFakeHostFs({
        files: {
          '/ws/readme.md': 'hello',
          '/extra/data.txt': 'extra data',
        },
        dirs: ['/ws', '/extra'],
      });
      const fs = new LocalWorkspaceFileSystem(extraHostFs, {
        workDir: '/ws',
        additionalDirs: ['/extra'],
      });
      const content = await fs.readText('/extra/data.txt');
      expect(content).toBe('extra data');
    });

    it('rejects path outside additionalDirs', async () => {
      const extraHostFs = makeFakeHostFs({
        files: {
          '/ws/readme.md': 'hello',
          '/other/secret.txt': 'secret',
        },
        dirs: ['/ws', '/other'],
      });
      const fs = new LocalWorkspaceFileSystem(extraHostFs, {
        workDir: '/ws',
        additionalDirs: ['/extra'],
      });
      await expect(fs.readText('/other/secret.txt')).rejects.toThrow();
    });
  });

  // ---- isolation -----------------------------------------------------------

  describe('isolation', () => {
    it('two backends with different workDirs are isolated', async () => {
      const hostFs2 = makeFakeHostFs({
        files: {
          '/wsA/a.txt': 'A',
          '/wsB/b.txt': 'B',
        },
        dirs: ['/wsA', '/wsB'],
      });
      const fsA = new LocalWorkspaceFileSystem(hostFs2, {
        workDir: '/wsA',
        additionalDirs: [],
      });
      const fsB = new LocalWorkspaceFileSystem(hostFs2, {
        workDir: '/wsB',
        additionalDirs: [],
      });

      await expect(fsA.readText('a.txt')).resolves.toBe('A');
      await expect(fsA.readText('/wsB/b.txt')).rejects.toThrow();

      await expect(fsB.readText('b.txt')).resolves.toBe('B');
      await expect(fsB.readText('/wsA/a.txt')).rejects.toThrow();
    });

    it('two backends with shared additionalDirs can see shared files', async () => {
      const hostFs3 = makeFakeHostFs({
        files: {
          '/wsA/a.txt': 'A',
          '/wsB/b.txt': 'B',
          '/shared/s.txt': 'shared',
        },
        dirs: ['/wsA', '/wsB', '/shared'],
      });
      const fsA = new LocalWorkspaceFileSystem(hostFs3, {
        workDir: '/wsA',
        additionalDirs: ['/shared'],
      });
      const fsB = new LocalWorkspaceFileSystem(hostFs3, {
        workDir: '/wsB',
        additionalDirs: ['/shared'],
      });

      await expect(fsA.readText('/shared/s.txt')).resolves.toBe('shared');
      await expect(fsB.readText('/shared/s.txt')).resolves.toBe('shared');
    });
  });

  // ---- disposal ------------------------------------------------------------

  describe('dispose', () => {
    it('is idempotent', () => {
      const fs = makeFs();
      expect(() => fs.dispose()).not.toThrow();
      expect(() => fs.dispose()).not.toThrow();
    });

    it('does not prevent further operations (no-op dispose)', async () => {
      const fs = makeFs();
      fs.dispose();
      const content = await fs.readText('readme.md');
      expect(content).toBe('hello world');
    });
  });
});

// ============================================================================
// WorkspaceFileSystemFactory tests
// ============================================================================

describe('LocalWorkspaceFileSystemFactory', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let hostFs: IHostFileSystem;

  beforeEach(() => {
    disposables = new DisposableStore();
    hostFs = makeFakeHostFs({
      files: { '/ws/readme.md': 'hello world' },
      dirs: ['/ws'],
    });

    ix = createServices(disposables, {
      base: [],
      additionalServices: (reg) => {
        reg.defineInstance(IHostFileSystem, hostFs);
        reg.define(IWorkspaceFileSystemFactory, LocalWorkspaceFileSystemFactory);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('resolves through DI and creates a backend', () => {
    const factory = ix.get(IWorkspaceFileSystemFactory);
    const fs = factory.create({
      sessionId: 's1',
      workDir: '/ws',
      additionalDirs: [],
    });
    expect(fs).toBeDefined();
  });

  it('created backend can read files within workspace', async () => {
    const factory = ix.get(IWorkspaceFileSystemFactory);
    const fs = factory.create({
      sessionId: 's1',
      workDir: '/ws',
      additionalDirs: [],
    });
    const content = await fs.readText('readme.md');
    expect(content).toBe('hello world');
  });

  it('created backend rejects paths outside workspace', async () => {
    const factory = ix.get(IWorkspaceFileSystemFactory);
    const fs = factory.create({
      sessionId: 's1',
      workDir: '/ws',
      additionalDirs: [],
    });
    await expect(fs.readText('/etc/passwd')).rejects.toThrow();
  });

  it('each create call returns a distinct backend', () => {
    const factory = ix.get(IWorkspaceFileSystemFactory);
    const fs1 = factory.create({ sessionId: 's1', workDir: '/ws', additionalDirs: [] });
    const fs2 = factory.create({ sessionId: 's2', workDir: '/ws', additionalDirs: [] });
    expect(fs1).not.toBe(fs2);
  });
});
