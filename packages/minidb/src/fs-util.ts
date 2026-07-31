// src/fs-util.ts
//
// Small filesystem helpers for open/persist: file sizing, atomic sidecar
// writes, and value-mode resolution.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ValueMode } from './recovery.js';
import type { ValueModeSetting } from './types.js';

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

/** Write a small metadata file atomically (tmp + rename), so a crash cannot
 *  leave a torn definition file that would force openers into error/rebuild. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

export async function resolveValueMode(mode: ValueModeSetting, dir: string, maxMemoryBytes: number | null): Promise<ValueMode> {
  if (mode !== 'auto') return mode;
  if (maxMemoryBytes === null) return 'memory';
  const total = (await fileSize(path.join(dir, 'db.snapshot'))) + (await fileSize(path.join(dir, 'db.wal')));
  return total > maxMemoryBytes ? 'disk' : 'memory';
}
