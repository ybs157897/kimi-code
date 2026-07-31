/**
 * Prompt media resolution for the desktop sidecar — mirrors
 * `packages/kap-server/src/routes/prompts.ts` (`assertPromptFileRefs` /
 * `resolvePromptMediaFiles`) so the desktop `submitPrompt` path keeps the exact
 * same semantics: file references are validated before anything session-scoped
 * happens, uploaded bytes are materialized into the session's own
 * attachments/cache directories (never dropped), and every media helper comes
 * from `@moonshot-ai/agent-core-v2` — the same package the kap-server route
 * imports them from, so behavior cannot drift.
 *
 * Pure engine-side logic: no Fastify/HTTP types anywhere in this module.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { RPCError } from '@moonshot-ai/klient';
import {
  buildImageCompressionCaption,
  buildKimiFileUrl,
  buildUnsupportedImageNotice,
  compressBase64ForModel,
  compressImageForModel,
  decodeBase64Prefix,
  isError2,
  isModelAcceptedImageMime,
  normalizeImageMime,
  persistOriginalImage,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
  type GetResult,
  type IFileService,
  type IHostFileSystem,
} from '@moonshot-ai/agent-core-v2';

import type { WireMessageContent } from './wire.js';

const REQUEST_INVALID = 40001;
const FILE_NOT_FOUND = 40407;

/** Mirrors kap-server routes/prompts.ts VIDEO_EXT_BY_MIME. */
const VIDEO_EXT_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/mpeg': '.mpeg',
};

/** Mirrors kap-server routes/prompts.ts ATTACHMENT_NAME_MAX. */
const ATTACHMENT_NAME_MAX = 100;

/**
 * Fail fast on stale or mis-kinded file references before anything
 * session-scoped happens: a bad `file_id` (unknown, or a real file used with
 * the wrong media kind, e.g. a PDF submitted as a video) must reject the
 * request without touching the session's model/thinking/permission.
 *
 * Mirrors kap-server `assertPromptFileRefs` (routes/prompts.ts): `file.not_found`
 * maps to 40407, a media-kind mismatch to 40001 — the same codes the REST route
 * reports.
 */
export async function assertPromptFileRefs(
  content: readonly WireMessageContent[],
  store: IFileService,
): Promise<void> {
  for (const part of content) {
    try {
      if (part.type === 'file') {
        await store.get(part.file_id);
      } else if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'file') {
        const file = await store.get(part.source.file_id);
        assertMediaFile(file, part.type);
      }
    } catch (error) {
      throw mapPromptFileError(error);
    }
  }
}

/** Map an IFileService/engine error onto the kap-server prompt error code. */
export function mapPromptFileError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (isError2(error) && error.code === 'file.not_found') {
    return new RPCError(FILE_NOT_FOUND, error.message);
  }
  throw error;
}

/** Mirrors kap-server `assertMediaFile` (routes/prompts.ts): 40001 on mismatch. */
function assertMediaFile(file: GetResult, expected: 'image' | 'video'): void {
  const prefix = expected === 'video' ? 'video/' : 'image/';
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new RPCError(
    REQUEST_INVALID,
    `file ${file.meta.id} is ${file.meta.media_type}, not ${expected === 'video' ? 'a video' : 'an image'}`,
  );
}

export interface ResolvePromptMediaOptions {
  /** Resolve `<sessionDir>/media-originals` for pre-compression originals. */
  readonly resolveOriginalsDir?: () => Promise<string | undefined>;
  /** Resolve `<sessionDir>/attachments` (falls back to `cacheDir`). */
  readonly resolveAttachmentsDir?: () => Promise<string | undefined>;
  /** Filesystem used for the best-effort originals store. */
  readonly hostFs: IHostFileSystem;
}

export interface ResolvedPromptContent {
  readonly content: WireMessageContent[];
  readonly changed: boolean;
}

/**
 * Resolve every file-backed prompt part against the App-scope `IFileService`
 * before the prompt is submitted:
 *
 *  - plain files → materialized into the session attachments dir, replaced by
 *    an "Attached file ..." path notice the model can read with the Read tool;
 *  - images → bytes sniffed (authoritative), format-gated, normalized and
 *    compressed, re-emitted as a base64 image part (originals persisted next
 *    to the session with a compression caption);
 *  - videos → materialized into the cache dir and carried as an internal
 *    `kimi-file://<id>?path=...` reference the engine resolves at request time.
 *
 * Mirrors kap-server `resolvePromptMediaFiles` (routes/prompts.ts). Unrelated
 * parts (tool_use/tool_result/thinking) pass through untouched.
 */
export async function resolvePromptMediaFiles(
  body: readonly WireMessageContent[],
  store: IFileService,
  cacheDir: string,
  options: ResolvePromptMediaOptions,
): Promise<ResolvedPromptContent> {
  let changed = false;
  let originalsDir: string | undefined;
  let originalsDirResolved = false;
  const resolveOriginalsDir = async (): Promise<string | undefined> => {
    if (!originalsDirResolved) {
      originalsDirResolved = true;
      originalsDir = await options.resolveOriginalsDir?.().catch(() => undefined);
    }
    return originalsDir;
  };
  let attachmentsDir: string | undefined;
  let attachmentsDirResolved = false;
  const resolveAttachmentsDir = async (): Promise<string> => {
    if (!attachmentsDirResolved) {
      attachmentsDirResolved = true;
      attachmentsDir = await options.resolveAttachmentsDir?.().catch(() => undefined);
    }
    return attachmentsDir ?? cacheDir;
  };

  const content: WireMessageContent[] = [];
  for (const part of body) {
    // Inline base64 image: compress the payload in place, exactly like the
    // kap-server path for REST clients that submit an image without uploading.
    if (part.type === 'image' && part.source.kind === 'base64') {
      const effectiveMime = resolveEffectiveImageMime(
        part.source.media_type,
        decodeBase64Prefix(part.source.data),
      );
      if (!isModelAcceptedImageMime(effectiveMime)) {
        const bytes = Buffer.from(part.source.data, 'base64');
        const name = `image.${imageExtensionForMime(effectiveMime)}`;
        const persisted = await persistAttachmentBytes(
          bytes,
          `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}-${name}`,
          await resolveAttachmentsDir(),
        );
        content.push({
          type: 'text',
          text:
            persisted === null
              ? buildUnsupportedImageNotice(effectiveMime)
              : buildAttachedFileNotice(name, effectiveMime, bytes.length, persisted),
        });
        changed = true;
        continue;
      }
      const canonicalMime = normalizeImageMime(effectiveMime);
      const compressed = await compressBase64ForModel(part.source.data, canonicalMime);
      if (compressed.changed) {
        const dir = await resolveOriginalsDir();
        const originalPath = await persistOriginalImage(
          Buffer.from(part.source.data, 'base64'),
          part.source.media_type,
          { dir, hostFs: options.hostFs },
        );
        content.push({
          type: 'text',
          text: buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: part.source.media_type,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          }),
        });
        content.push({
          type: 'image',
          source: { kind: 'base64', media_type: compressed.mimeType, data: compressed.base64 },
        });
        changed = true;
      } else {
        content.push(part);
      }
      continue;
    }

    // Remote image URL: reject only when the path extension names a format
    // providers reject; the notice keeps the URL so the model can still fetch
    // and convert the image.
    if (part.type === 'image' && part.source.kind === 'url') {
      const extMime = unsupportedImageMimeFromUrl(part.source.url);
      if (extMime !== null) {
        content.push({ type: 'text', text: buildUnsupportedImageNotice(extMime, part.source.url) });
        changed = true;
        continue;
      }
      content.push(part);
      continue;
    }

    // Arbitrary file attachment: materialize the uploaded bytes next to the
    // session and replace the part with a path reference.
    if (part.type === 'file') {
      const file = await store.get(part.file_id).catch((error: unknown) => {
        throw mapPromptFileError(error);
      });
      const attachedPath = await materializeAttachmentToDir(file, await resolveAttachmentsDir());
      content.push({
        type: 'text',
        text: buildAttachedFileNotice(file.meta.name, file.meta.media_type, file.meta.size, attachedPath),
      });
      changed = true;
      continue;
    }

    if ((part.type !== 'image' && part.type !== 'video') || part.source.kind !== 'file') {
      content.push(part);
      continue;
    }

    const file = await store.get(part.source.file_id).catch((error: unknown) => {
      throw mapPromptFileError(error);
    });
    assertMediaFile(file, part.type);
    if (part.type === 'image') {
      const data = await readFileOrStream(file);
      let mediaType = file.meta.media_type;
      let bytes: Uint8Array = data;
      mediaType = resolveEffectiveImageMime(mediaType, data);
      if (!isModelAcceptedImageMime(mediaType)) {
        const persisted = await persistAttachmentBytes(
          data,
          `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`,
          await resolveAttachmentsDir(),
        );
        content.push({
          type: 'text',
          text:
            persisted === null
              ? buildUnsupportedImageNotice(mediaType, file.meta.name)
              : buildAttachedFileNotice(file.meta.name, mediaType, file.meta.size, persisted),
        });
        changed = true;
        continue;
      }
      mediaType = normalizeImageMime(mediaType);
      const compressed = await compressImageForModel(data, mediaType);
      if (compressed.changed) {
        const dir = await resolveOriginalsDir();
        const originalPath = await persistOriginalImage(data, mediaType, {
          dir,
          hostFs: options.hostFs,
        });
        content.push({
          type: 'text',
          text: buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: mediaType,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          }),
        });
      }
      bytes = compressed.data;
      mediaType = compressed.mimeType;
      content.push({
        type: 'image',
        source: {
          kind: 'base64',
          media_type: mediaType,
          data: Buffer.from(bytes).toString('base64'),
        },
      });
      changed = true;
      continue;
    }

    // Uploaded video: materialize a local copy the model can open as a
    // fallback, and carry the upload into context as an internal
    // `kimi-file://<id>?path=<materialized path>` reference. The engine
    // resolves it to a provider form at request time, so the edge never
    // uploads and never blocks on the provider.
    const cachePath = await materializeVideoToCache(file, cacheDir);
    content.push({
      type: 'video',
      source: { kind: 'url', url: buildKimiFileUrl(file.meta.id, cachePath) },
    });
    changed = true;
  }
  return { content, changed };
}

/** Mirrors kap-server `materializeVideoToCache` (routes/prompts.ts). */
async function materializeVideoToCache(file: GetResult, cacheDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const ext = extname(file.meta.name) || (VIDEO_EXT_BY_MIME[file.meta.media_type.toLowerCase()] ?? '.bin');
  const target = join(cacheDir, `${file.meta.id}${ext}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

/**
 * Attachment file names are untrusted (a wire field): strip path separators,
 * control chars, and leading dots so the materialized file can never escape
 * its directory or land as a hidden file, and cap the length. Mirrors
 * kap-server `sanitizeAttachmentName` (routes/prompts.ts).
 */
function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replaceAll(/[\\/]/g, '_')
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/** Stream an uploaded file into `dir` as `<fileId>-<sanitized name>`. */
async function materializeAttachmentToDir(file: GetResult, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

/**
 * Write already-buffered attachment bytes into `dir` under `name` (the caller
 * builds the name: file-id or content-hash prefixed). Best effort — returns
 * null instead of throwing so a prompt never fails over the persisted copy.
 */
async function persistAttachmentBytes(
  bytes: Uint8Array,
  name: string,
  dir: string,
): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, name);
    const info = await stat(target).catch(() => undefined);
    if (info?.size !== bytes.length) await writeFile(target, bytes);
    return target;
  } catch {
    return null;
  }
}

/** Derive a file extension from an image MIME (`image/svg+xml` → `svg`). */
function imageExtensionForMime(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase().split('+')[0] ?? '';
  const ext = subtype.replaceAll(/[^a-z0-9-]/g, '');
  return ext.length > 0 ? ext : 'img';
}

// This notice's exact shape is a client contract: kimi-web's messagesToTurns
// parses it (ATTACHED_FILE_NOTICE_RE) to rebuild the attachment chip after a
// resync — change the wording there too.
function buildAttachedFileNotice(name: string, mediaType: string, size: number, path: string): string {
  return `Attached file "${name}" (${mediaType}, ${size} bytes): ${path} — open it with the Read tool`;
}

async function readFileOrStream(file: GetResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream()) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}
