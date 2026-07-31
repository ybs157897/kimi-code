/**
 * Product facade pure helpers — envelope construction, positional-arg
 * validation, wire-metadata normalization, the undo-message pager, the
 * base64 stream re-blocker, and the small kap-server parity utilities
 * (snake→camel keys, export naming, untitled detection).
 */

import { Readable } from 'node:stream';

import { RPCError } from '@moonshot-ai/klient';
import { toProtocolMessage } from '@moonshot-ai/agent-core-v2';

import { ulid } from './builders.js';
import {
  DEFAULT_UNDO_MESSAGE_PAGE_SIZE,
  MAX_UNDO_MESSAGE_PAGE_SIZE,
  PRODUCT_STREAM_CHUNK_BYTES,
  REQUEST_INVALID,
} from './constants.js';
import type { ProductStreamChunk } from './types.js';
import type { WireEnvelope, WireMessage, WirePage } from './wire.js';

export function ok<T>(data: T): WireEnvelope<T> {
  return { code: 0, msg: 'success', data, request_id: ulid('req_') };
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RPCError(REQUEST_INVALID, `product call missing ${name}`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors kap-server `customMetadataFromWire`: drop `cwd` from the persisted
 *  custom metadata (the workspace registry is the cwd source of truth). */
export function customMetadataFromWire(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const { cwd: _drop, ...custom } = metadata;
  return Object.keys(custom).length === 0 ? undefined : custom;
}

/** Temp-dir id fragment for export — mirrors kap-server's sanitizeSessionId. */
export function sanitizeExportId(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'session';
}

/** Mirrors the export service's default zip name (`kimi-debug-<id8>-<date>.zip`). */
export function defaultExportZipName(sessionId: string, now: Date): string {
  const shortId = sessionId.slice(0, 8);
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  return `kimi-debug-${shortId}-${timestamp}.zip`;
}

/** Mirrors agent-core-v2's `isUntitled` (agent/rpc/prompt-metadata.ts). */
export function isUntitledTitle(title: string | undefined): boolean {
  return title === undefined || title.trim().length === 0 || title === 'New Session';
}

/** Re-block a byte stream into fixed-size base64 frames with a running seq. */
export async function* base64ChunkStream(source: Readable): AsyncGenerator<ProductStreamChunk> {
  let seq = 0;
  let pending: Buffer = Buffer.alloc(0);
  for await (const part of source) {
    const buf = typeof part === 'string' ? Buffer.from(part, 'utf8') : (part as Buffer);
    pending = pending.byteLength === 0 ? buf : Buffer.concat([pending, buf]);
    while (pending.byteLength >= PRODUCT_STREAM_CHUNK_BYTES) {
      yield { chunk: pending.subarray(0, PRODUCT_STREAM_CHUNK_BYTES).toString('base64'), seq };
      seq += 1;
      pending = pending.subarray(PRODUCT_STREAM_CHUNK_BYTES);
    }
  }
  if (pending.byteLength > 0) {
    yield { chunk: pending.toString('base64'), seq };
  }
}

export function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Mirrors kap-server `pageUndoMessages` (routes/sessions.ts). */
export function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly unknown[],
  requestedPageSize: number | undefined,
): WirePage<WireMessage> {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(
      sessionId,
      index,
      message as Parameters<typeof toProtocolMessage>[2],
      sessionCreatedAtMs,
    ),
  ) as unknown as WireMessage[];
  const desc = [...all].reverse();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

/** Mirrors kap-server `convertKeysSnakeToCamel` (routes/config.ts). */
export function convertKeysSnakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(convertKeysSnakeToCamel);
  if (isRecord(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[snakeToCamel(key)] = convertKeysSnakeToCamel(value);
    }
    return result;
  }
  return obj;
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
