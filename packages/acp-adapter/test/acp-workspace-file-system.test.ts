import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpWorkspaceFileSystem } from '../src/acp-workspace-file-system';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBackend() {
  const root = await mkdtemp(join(tmpdir(), 'acp-workspace-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  tempDirs.push(root);
  const connection = {
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
  } as unknown as AgentSideConnection;
  return {
    root,
    workspace,
    backend: new AcpWorkspaceFileSystem({
      conn: connection,
      sessionId: 'session-1',
      workDir: workspace,
      additionalDirs: [],
    }),
  };
}

describe('AcpWorkspaceFileSystem', () => {
  it('rejects existing and not-yet-created paths beneath an escaping symlink', async () => {
    const { root, workspace, backend } = await makeBackend();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(workspace, 'escape'));

    await expect(backend.readBytes('escape/secret.txt')).rejects.toMatchObject({
      code: 'EACCES',
    });
    await expect(
      backend.writeBytes('escape/new.txt', new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'EACCES' });
    await expect(readdir(outside)).resolves.toEqual(['secret.txt']);
  });

  it('reports the HostDirEntry isSymbolicLink contract field', async () => {
    const { workspace, backend } = await makeBackend();
    await writeFile(join(workspace, 'target.txt'), 'ok');
    await symlink(join(workspace, 'target.txt'), join(workspace, 'link.txt'));

    const entries = await backend.readdir('.');
    expect(entries.find((entry) => entry.name === 'link.txt')).toMatchObject({
      isSymbolicLink: true,
    });
    expect(entries.find((entry) => entry.name === 'link.txt')).not.toHaveProperty(
      'isSymlink',
    );
  });
});
