/**
 * promptMedia tests — the desktop submitPrompt media pipeline mirrors
 * kap-server's assertPromptFileRefs / resolvePromptMediaFiles: file refs are
 * validated before anything session-scoped happens, uploaded bytes are
 * materialized into session-owned dirs (never dropped), and error codes match
 * the REST route (40407 file not found / 40001 media-kind mismatch).
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { RPCError } from '@moonshot-ai/klient';
import {
  Error2,
  type FileMeta,
  type GetResult,
  type IFileService,
  type IHostFileSystem,
} from '@moonshot-ai/agent-core-v2';

import { assertPromptFileRefs, resolvePromptMediaFiles } from './promptMedia.js';
import type { WireMessageContent } from './wire.js';

/** 1×1 transparent PNG — accepted by the format gate, too small to compress. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class FakeFileService implements IFileService {
  declare readonly _serviceBrand: undefined;
  private seq = 0;
  readonly files = new Map<string, { meta: FileMeta; bytes: Buffer }>();

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
    return this.files.get(id)!.meta;
  }

  async get(fileId: string): Promise<GetResult> {
    const file = this.files.get(fileId);
    if (file === undefined) {
      throw new Error2('file.not_found', `file ${fileId} does not exist`);
    }
    return { meta: file.meta, stream: () => Readable.from([file.bytes]) };
  }

  async delete(fileId: string): Promise<void> {
    this.files.delete(fileId);
  }
}

const fakeHostFs: IHostFileSystem = {
  mkdir: async () => undefined,
  stat: async () => null,
  writeBytes: async () => undefined,
} as unknown as IHostFileSystem;

function pngFile(store: FakeFileService, name = 'pic.png'): Promise<string> {
  return store.save(Readable.from([Buffer.from(TINY_PNG_BASE64, 'base64')]), name, {
    mimeType: 'image/png',
  }).then((meta) => meta.id);
}

describe('assertPromptFileRefs', () => {
  it('passes for text-file, image and video refs that exist with the right kind', async () => {
    const store = new FakeFileService();
    const fileId = await pngFile(store);
    const videoId = (await store.save(Readable.from([Buffer.from('x')]), 'clip.mp4', { mimeType: 'video/mp4' })).id;
    const textId = (await store.save(Readable.from([Buffer.from('hello')]), 'notes.txt')).id;
    const content: WireMessageContent[] = [
      { type: 'file', file_id: textId, name: 'notes.txt', media_type: 'text/plain', size: 5 },
      { type: 'image', source: { kind: 'file', file_id: fileId } },
      { type: 'video', source: { kind: 'file', file_id: videoId } },
    ];
    await expect(assertPromptFileRefs(content, store)).resolves.toBeUndefined();
  });

  it('rejects an unknown file_id with the kap-server FILE_NOT_FOUND code (40407)', async () => {
    const store = new FakeFileService();
    const content: WireMessageContent[] = [
      { type: 'file', file_id: 'f_missing', name: 'x', media_type: 'text/plain', size: 1 },
    ];
    await expect(assertPromptFileRefs(content, store)).rejects.toMatchObject({
      code: 40407,
    });
  });

  it('rejects a PDF masquerading as a video with 40001', async () => {
    const store = new FakeFileService();
    const pdfId = (await store.save(Readable.from([Buffer.from('%PDF')]), 'doc.pdf', { mimeType: 'application/pdf' })).id;
    const content: WireMessageContent[] = [
      { type: 'video', source: { kind: 'file', file_id: pdfId } },
    ];
    await expect(assertPromptFileRefs(content, store)).rejects.toMatchObject({
      code: 40001,
      message: expect.stringContaining('not a video'),
    });
  });
});

describe('resolvePromptMediaFiles', () => {
  async function setup(): Promise<{ root: string; cacheDir: string; attachmentsDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-prompt-media-'));
    return {
      root,
      cacheDir: join(root, 'cache'),
      attachmentsDir: join(root, 'attachments'),
    };
  }

  it('materializes a plain text file into the session attachments dir as a readable path notice', async () => {
    const store = new FakeFileService();
    const { root, cacheDir, attachmentsDir } = await setup();
    const textId = (await store.save(Readable.from([Buffer.from('hello world')]), 'notes.txt', { mimeType: 'text/plain' })).id;
    const content: WireMessageContent[] = [
      { type: 'file', file_id: textId, name: 'notes.txt', media_type: 'text/plain', size: 11 },
    ];
    const result = await resolvePromptMediaFiles(content, store, cacheDir, {
      hostFs: fakeHostFs,
      resolveAttachmentsDir: async () => attachmentsDir,
    });
    expect(result.changed).toBe(true);
    const text = result.content[0];
    expect(text).toMatchObject({ type: 'text' });
    const notice = (text as { text: string }).text;
    expect(notice).toContain('Attached file');
    expect(notice).toContain(attachmentsDir);
    // The bytes actually landed in the session-owned directory.
    const target = notice.match(/:\s*(\S+)\s*—/)?.[1];
    expect(target).toBeDefined();
    expect(await readFile(target!, 'utf8')).toBe('hello world');
    await rm(root, { recursive: true, force: true });
  });

  it('turns an uploaded image into a base64 image part', async () => {
    const store = new FakeFileService();
    const { root, cacheDir, attachmentsDir } = await setup();
    const fileId = await pngFile(store);
    const content: WireMessageContent[] = [
      { type: 'image', source: { kind: 'file', file_id: fileId } },
    ];
    const result = await resolvePromptMediaFiles(content, store, cacheDir, {
      hostFs: fakeHostFs,
      resolveAttachmentsDir: async () => attachmentsDir,
    });
    expect(result.changed).toBe(true);
    const part = result.content[0];
    expect(part).toMatchObject({ type: 'image' });
    const source = (part as { source: { kind: 'base64'; media_type: string; data: string } }).source;
    expect(source.kind).toBe('base64');
    expect(source.media_type).toBe('image/png');
    expect(Buffer.from(source.data, 'base64').equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('turns an uploaded video into a kimi-file reference and materializes a cache copy', async () => {
    const store = new FakeFileService();
    const { root, cacheDir, attachmentsDir } = await setup();
    const videoBytes = Buffer.from('fake-mp4-bytes');
    const videoId = (await store.save(Readable.from([videoBytes]), 'clip.mp4', { mimeType: 'video/mp4' })).id;
    const content: WireMessageContent[] = [
      { type: 'video', source: { kind: 'file', file_id: videoId } },
    ];
    const result = await resolvePromptMediaFiles(content, store, cacheDir, {
      hostFs: fakeHostFs,
      resolveAttachmentsDir: async () => attachmentsDir,
    });
    expect(result.changed).toBe(true);
    const part = result.content[0];
    expect(part).toMatchObject({ type: 'video' });
    const source = (part as { source: { kind: 'url'; url: string } }).source;
    expect(source.kind).toBe('url');
    expect(source.url).toMatch(new RegExp(`^kimi-file://${videoId}\\?path=`));
    // The cache copy exists with the right bytes and the original extension.
    const cachePath = decodeURIComponent(source.url.split('path=')[1]!);
    expect(cachePath).toContain(cacheDir);
    expect(await readFile(cachePath)).toEqual(videoBytes);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects an unknown fileId with 40407 (same error the kap-server route reports)', async () => {
    const store = new FakeFileService();
    const { root, cacheDir, attachmentsDir } = await setup();
    const content: WireMessageContent[] = [
      { type: 'image', source: { kind: 'file', file_id: 'f_missing' } },
    ];
    await expect(
      resolvePromptMediaFiles(content, store, cacheDir, {
        hostFs: fakeHostFs,
        resolveAttachmentsDir: async () => attachmentsDir,
      }),
    ).rejects.toMatchObject({ code: 40407 });
    await rm(root, { recursive: true, force: true });
  });

  it('gates unsupported image formats to a notice instead of dropping the bytes', async () => {
    const store = new FakeFileService();
    const { root, cacheDir, attachmentsDir } = await setup();
    // Real AVIF box header ('ftyp' brand 'avif') labelled image/png — the
    // sniffed format is authoritative.
    const avifBytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypavif', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);
    const fileId = (await store.save(Readable.from([avifBytes]), 'pic.png', { mimeType: 'image/png' })).id;
    const content: WireMessageContent[] = [
      { type: 'image', source: { kind: 'file', file_id: fileId } },
    ];
    const result = await resolvePromptMediaFiles(content, store, cacheDir, {
      hostFs: fakeHostFs,
      resolveAttachmentsDir: async () => attachmentsDir,
    });
    expect(result.changed).toBe(true);
    const text = result.content[0] as { type: 'text'; text: string };
    expect(text.type).toBe('text');
    expect(text.text).toContain('Attached file');
    await rm(root, { recursive: true, force: true });
  });

  it('passes through unrelated parts untouched', async () => {
    const store = new FakeFileService();
    const { root, cacheDir, attachmentsDir } = await setup();
    const content: WireMessageContent[] = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'hmm' },
    ];
    const result = await resolvePromptMediaFiles(content, store, cacheDir, {
      hostFs: fakeHostFs,
      resolveAttachmentsDir: async () => attachmentsDir,
    });
    expect(result.changed).toBe(false);
    expect(result.content).toEqual(content);
    await rm(root, { recursive: true, force: true });
  });
});

describe('promptMedia error codes', () => {
  it('maps file.not_found to RPCError 40407', async () => {
    const store = new FakeFileService();
    const content: WireMessageContent[] = [
      { type: 'file', file_id: 'f_missing', name: 'x', media_type: 'text/plain', size: 1 },
    ];
    try {
      await assertPromptFileRefs(content, store);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RPCError);
      expect((error as RPCError).code).toBe(40407);
    }
  });
});
