/**
 * Low-level durable file-write primitives — atomic writes plus file and
 * directory fsync helpers.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'pathe';

const isWindows = process.platform === 'win32';

/** Whether `error` is a Node.js errno exception with the given `code`. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/** Shorthand for the most common errno check: file/directory not found. */
export function isEnoent(error: unknown): boolean {
  return isErrno(error, 'ENOENT');
}

export async function syncDir(dirPath: string): Promise<void> {
  if (isWindows) return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export function syncDirSync(dirPath: string): void {
  if (isWindows) return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * On Windows, `rename()` fails with EPERM/EEXIST when the target exists.
 * Remove the target first so the subsequent rename succeeds.
 */
async function unlinkTargetForWindows(filePath: string): Promise<void> {
  if (!isWindows) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Best-effort cleanup of a temp file that was never renamed. */
async function cleanupTemp(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch {
    // already removed or never created — safe to ignore
  }
}

function makeTmpPath(filePath: string): string {
  return `${filePath}.tmp.${String(process.pid)}.${randomBytes(4).toString('hex')}`;
}

export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await unlinkTargetForWindows(filePath);
    await rename(tmpPath, filePath);
    renamed = true;
    await syncDir(dirname(filePath));
  } finally {
    if (!renamed) await cleanupTemp(tmpPath);
  }
}

function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    nodeFs.fsync(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
  mode?: number,
): Promise<void> {
  const tmpPath = makeTmpPath(filePath);
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      await fh.writeFile(content);
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    await unlinkTargetForWindows(filePath);
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) await cleanupTemp(tmpPath);
  }
}

export async function atomicWriteStream(
  filePath: string,
  source: AsyncIterable<Uint8Array>,
  mode?: number,
): Promise<void> {
  const tmpPath = makeTmpPath(filePath);
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      for await (const chunk of source) {
        if (chunk.byteLength > 0) {
          await fh.writeFile(chunk);
        }
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    await unlinkTargetForWindows(filePath);
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) await cleanupTemp(tmpPath);
  }
}
