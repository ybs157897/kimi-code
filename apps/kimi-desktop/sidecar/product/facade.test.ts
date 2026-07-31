/**
 * ProductFacade tests — submitPrompt validation/ordering (file refs are
 * checked before any control mutation) and the upload session lifecycle
 * (temp-file accumulation, limits, cleanup on every exit path), using a fake
 * scope + klient so the engine itself is never needed.
 */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { type AgentHandle, type Klient } from '@moonshot-ai/klient';
import {
  Error2,
  IBootstrapService,
  IFileService,
  IHostFileSystem,
  ISessionContext,
  ISessionLifecycleService,
  type FileMeta,
  type GetResult,
} from '@moonshot-ai/agent-core-v2';

import { ProductFacade } from './facade.js';
import type { WirePromptSubmission } from './wire.js';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class FakeFileService implements IFileService {
  declare readonly _serviceBrand: undefined;
  private seq = 0;
  readonly files = new Map<string, { meta: FileMeta; bytes: Buffer }>();
  saves: Array<{ filename: string; bytes: Buffer; mimeType?: string }> = [];

  async save(
    source: Readable,
    filename: string,
    options?: { name?: string; mimeType?: string },
  ): Promise<FileMeta> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    const id = `f_fake_${++this.seq}`;
    this.files.set(id, {
      meta: {
        id,
        name: options?.name ?? filename,
        media_type: options?.mimeType ?? 'application/octet-stream',
        size: bytes.length,
        created_at: new Date().toISOString(),
      },
      bytes,
    });
    this.saves.push({ filename, bytes, mimeType: options?.mimeType });
    return this.files.get(id)!.meta;
  }

  async get(fileId: string): Promise<GetResult> {
    const file = this.files.get(fileId);
    if (file === undefined) throw new Error2('file.not_found', `file ${fileId} does not exist`);
    return { meta: file.meta, stream: () => Readable.from([file.bytes]) };
  }

  async delete(fileId: string): Promise<void> {
    this.files.delete(fileId);
  }
}

interface RecordedAgent {
  model?: string;
  permission?: string;
  thinking?: string;
  prompts: unknown[];
}

function recordingKlient(): { klient: Klient; agents: Map<string, RecordedAgent> } {
  const agents = new Map<string, RecordedAgent>();
  const klient = {
    session: () => ({
      agent: (agentId: string) => {
        let rec = agents.get(agentId);
        if (rec === undefined) {
          rec = { prompts: [] };
          agents.set(agentId, rec);
        }
        const handle = {
          setModel: async (model: string) => {
            rec!.model = model;
          },
          setPermission: async (permission: string) => {
            rec!.permission = permission;
          },
          profile: {
            setThinking: async (thinking: string) => {
              rec!.thinking = thinking;
            },
          },
          prompt: async (input: { input: unknown }) => {
            rec!.prompts.push(input.input);
            return { turn_id: 7 };
          },
          cancel: async () => undefined,
        } as unknown as AgentHandle;
        return handle;
      },
    }),
  } as unknown as Klient;
  return { klient, agents };
}

async function makeFacade(limits?: { maxUploadBytes?: number; maxUploadChunkBase64?: number }): Promise<{
  facade: ProductFacade;
  store: FakeFileService;
  cacheDir: string;
  uploadsRoot: string;
  agents: Map<string, RecordedAgent>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-facade-'));
  const cacheDir = join(root, 'cache');
  const sessionDir = join(root, 'session');
  await mkdir(cacheDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const store = new FakeFileService();
  const { klient, agents } = recordingKlient();
  const scope = {
    accessor: {
      get: (token: unknown): unknown => {
        if (token === IFileService) return store;
        if (token === IBootstrapService) return { cacheDir };
        if (token === ISessionLifecycleService) {
          return {
            resume: async () => ({
              accessor: {
                get: (t: unknown): unknown =>
                  t === ISessionContext ? { sessionDir } : undefined,
              },
            }),
          };
        }
        if (token === IHostFileSystem) {
          return {
            mkdir: async () => undefined,
            stat: async () => null,
            writeBytes: async () => undefined,
          };
        }
        return undefined;
      },
    },
  };
  const facade = new ProductFacade(klient, scope as never, undefined, limits);
  return { facade, store, cacheDir, uploadsRoot: join(cacheDir, 'uploads'), agents };
}

describe('ProductFacade.submitPrompt ordering', () => {
  it('rejects an unknown file_id BEFORE touching model/thinking/permission', async () => {
    const { facade, store, agents } = await makeFacade();
    const input: WirePromptSubmission = {
      content: [{ type: 'file', file_id: 'f_missing', name: 'x', media_type: 'text/plain', size: 1 }],
      model: 'moonshot-v1',
      thinking: 'high',
      permission_mode: 'yolo',
    };
    await expect(facade.dispatch('submitPrompt', ['s-1', input], {})).rejects.toMatchObject({
      code: 40407,
    });
    expect(agents.get('main')).toBeUndefined();
    expect(store.saves).toHaveLength(0);
  });

  it('rejects a media-kind mismatch (PDF as video) with 40001 before controls', async () => {
    const { facade, store, agents } = await makeFacade();
    const pdfId = (
      await store.save(Readable.from([Buffer.from('%PDF')]), 'doc.pdf', {
        mimeType: 'application/pdf',
      })
    ).id;
    const input: WirePromptSubmission = {
      content: [{ type: 'video', source: { kind: 'file', file_id: pdfId } }],
      model: 'moonshot-v1',
    };
    await expect(facade.dispatch('submitPrompt', ['s-1', input], {})).rejects.toMatchObject({
      code: 40001,
    });
    expect(agents.get('main')).toBeUndefined();
  });

  it('materializes a plain file and applies controls only after media resolution', async () => {
    const { facade, store, agents } = await makeFacade();
    const textId = (
      await store.save(Readable.from([Buffer.from('hello')]), 'notes.txt', {
        mimeType: 'text/plain',
      })
    ).id;
    const input: WirePromptSubmission = {
      content: [
        { type: 'file', file_id: textId, name: 'notes.txt', media_type: 'text/plain', size: 5 },
      ],
      model: 'moonshot-v1',
      permission_mode: 'yolo',
    };
    await facade.dispatch('submitPrompt', ['s-1', input], {});
    const rec = agents.get('main')!;
    expect(rec.model).toBe('moonshot-v1');
    expect(rec.permission).toBe('yolo');
    expect(rec.prompts).toHaveLength(1);
    const parts = rec.prompts[0] as Array<{ type: string; text?: string }>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text).toContain('Attached file');
  });

  it('submits an uploaded image as a base64 image part', async () => {
    const { facade, store, agents } = await makeFacade();
    const fileId = (
      await store.save(Readable.from([Buffer.from(TINY_PNG_BASE64, 'base64')]), 'pic.png', {
        mimeType: 'image/png',
      })
    ).id;
    const input: WirePromptSubmission = {
      content: [{ type: 'image', source: { kind: 'file', file_id: fileId } }],
    };
    await facade.dispatch('submitPrompt', ['s-1', input], {});
    const parts = agents.get('main')!.prompts[0] as Array<{
      type: string;
      imageUrl?: { url: string };
    }>;
    expect(parts[0]?.type).toBe('image_url');
    expect(parts[0]?.imageUrl?.url).toMatch(/^data:image\/png;base64,/);
  });

  it('submits an uploaded video as a video reference', async () => {
    const { facade, store, agents } = await makeFacade();
    const videoId = (
      await store.save(Readable.from([Buffer.from('fake-mp4')]), 'clip.mp4', {
        mimeType: 'video/mp4',
      })
    ).id;
    const input: WirePromptSubmission = {
      content: [{ type: 'video', source: { kind: 'file', file_id: videoId } }],
    };
    await facade.dispatch('submitPrompt', ['s-1', input], {});
    const parts = agents.get('main')!.prompts[0] as Array<{
      type: string;
      videoUrl?: { url: string };
    }>;
    expect(parts[0]?.type).toBe('video_url');
    expect(parts[0]?.videoUrl?.url).toMatch(/^kimi-file:\/\//);
  });

  it('rejects an empty prompt after resolution with 40001', async () => {
    const { facade } = await makeFacade();
    await expect(
      facade.dispatch('submitPrompt', ['s-1', { content: [] }], {}),
    ).rejects.toMatchObject({ code: 40001 });
  });
});

describe('ProductFacade upload lifecycle', () => {
  it('saves a zero-byte file when uploadFinish follows uploadStart without chunks', async () => {
    const { facade, store, uploadsRoot } = await makeFacade();
    const start = await facade.dispatch(
      'uploadStart',
      [{ name: 'empty.txt', media_type: 'text/plain' }],
      {},
    );
    const uploadId = (start.data as { upload_id: string }).upload_id;

    const finish = await facade.dispatch('uploadFinish', [uploadId], {});

    expect(finish.data).toMatchObject({ name: 'empty.txt', media_type: 'text/plain', size: 0 });
    expect(store.saves[0]?.bytes).toHaveLength(0);
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it('streams chunks into a temp file and removes it after uploadFinish', async () => {
    const { facade, store, uploadsRoot } = await makeFacade();
    const start = await facade.dispatch(
      'uploadStart',
      [{ name: 'a.bin', media_type: 'application/octet-stream' }],
      {},
    );
    const uploadId = (start.data as { upload_id: string }).upload_id;
    expect(await readdir(uploadsRoot)).toHaveLength(1);

    await facade.dispatch('uploadChunk', [uploadId, Buffer.from('hello ').toString('base64')], {});
    await facade.dispatch('uploadChunk', [uploadId, Buffer.from('world').toString('base64')], {});

    const finish = await facade.dispatch('uploadFinish', [uploadId], {});
    const meta = finish.data as FileMeta;
    expect(meta.size).toBe(11);
    expect(store.saves[0]?.bytes.toString()).toBe('hello world');
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it('rejects invalid base64 with 40001 (session stays retryable, cancel cleans up)', async () => {
    const { facade, uploadsRoot } = await makeFacade();
    const start = await facade.dispatch('uploadStart', [{ name: 'a.bin' }], {});
    const uploadId = (start.data as { upload_id: string }).upload_id;
    await expect(
      facade.dispatch('uploadChunk', [uploadId, '!!!not-base64!!!'], {}),
    ).rejects.toMatchObject({ code: 40001 });
    await facade.dispatch('uploadCancel', [uploadId], {});
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it('rejects an oversized chunk frame with 40001; cancel removes the temp dir', async () => {
    const { facade, uploadsRoot } = await makeFacade({ maxUploadChunkBase64: 1024 });
    const start = await facade.dispatch('uploadStart', [{ name: 'a.bin' }], {});
    const uploadId = (start.data as { upload_id: string }).upload_id;
    const huge = 'A'.repeat(1025);
    await expect(facade.dispatch('uploadChunk', [uploadId, huge], {})).rejects.toMatchObject({
      code: 40001,
    });
    await facade.dispatch('uploadCancel', [uploadId], {});
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it('rejects an upload past the file cap with 41301 and removes the temp dir', async () => {
    const { facade, uploadsRoot } = await makeFacade({ maxUploadBytes: 1024 });
    const start = await facade.dispatch('uploadStart', [{ name: 'big.bin' }], {});
    const uploadId = (start.data as { upload_id: string }).upload_id;
    await facade.dispatch('uploadChunk', [uploadId, Buffer.alloc(1024, 0x41).toString('base64')], {});
    await expect(
      facade.dispatch('uploadChunk', [uploadId, Buffer.from('x').toString('base64')], {}),
    ).rejects.toMatchObject({ code: 41301 });
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it('removes the temp dir when uploadFinish fails', async () => {
    const { facade, uploadsRoot } = await makeFacade();
    const start = await facade.dispatch('uploadStart', [{ name: 'a.bin' }], {});
    const uploadId = (start.data as { upload_id: string }).upload_id;
    await facade.dispatch('uploadChunk', [uploadId, Buffer.from('x').toString('base64')], {});
    // Delete the temp dir out from under the session so save()'s read fails.
    const [dir] = await readdir(uploadsRoot);
    await rm(join(uploadsRoot, dir!), { recursive: true, force: true });
    await expect(facade.dispatch('uploadFinish', [uploadId], {})).rejects.toBeDefined();
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it('uploadCancel removes the temp dir idempotently', async () => {
    const { facade, uploadsRoot } = await makeFacade();
    const start = await facade.dispatch('uploadStart', [{ name: 'a.bin' }], {});
    const uploadId = (start.data as { upload_id: string }).upload_id;
    await facade.dispatch('uploadChunk', [uploadId, Buffer.from('x').toString('base64')], {});
    await facade.dispatch('uploadCancel', [uploadId], {});
    await facade.dispatch('uploadCancel', [uploadId], {});
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });

  it("cancelUploadsForConnection cleans only that connection's sessions", async () => {
    const { facade, uploadsRoot } = await makeFacade();
    await facade.dispatch('uploadStart', [{ name: 'a.bin' }], { connId: 'conn_1' });
    const other = await facade.dispatch('uploadStart', [{ name: 'b.bin' }], { connId: 'conn_2' });
    await facade.cancelUploadsForConnection('conn_1');
    expect(await readdir(uploadsRoot)).toHaveLength(1);
    await facade.dispatch('uploadCancel', [(other.data as { upload_id: string }).upload_id], {});
    expect(await readdir(uploadsRoot)).toHaveLength(0);
  });
});
