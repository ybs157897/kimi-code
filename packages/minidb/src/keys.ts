// src/keys.ts
//
// Key normalization: the canonical byte-string form for keys and range bounds,
// plus the small dt-normalization and lazy candidate-filter helpers shared by
// the write and query paths.

import type { RangeOptions } from './skiplist.js';

export const MAX_KEY_LEN = 128;

export function toBuf(key: string | Buffer): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
}
// Canonical byte-string form of a key: each char's code unit equals one byte of
// the key's UTF-8 encoding. The store and every derived index key their maps by
// this string, so a string key and the Buffer of its UTF-8 bytes (which is what
// the WAL/snapshot store) map to the same entry. Without this, a multi-byte
// (non-ASCII) string key is stored under one name (UTF-8 bytes, via the Buffer
// path) but looked up under another (the raw UTF-16 string), so get/del/scan and
// every index miss it.
export function toKStr(key: string | Buffer): string {
  return typeof key === 'string' ? Buffer.from(key, 'utf8').toString('binary') : key.toString('binary');
}
// Inverse of toKStr: turn a canonical byte-string back into the original UTF-8
// string for keys returned to callers (scan / findEq / dtRange / ...).
export function fromKStr(k: string): string {
  return Buffer.from(k, 'binary').toString('utf8');
}
// Canonicalize the string bounds of a range scan so they compare correctly
// against the canonically-keyed ordered index.
export function canonRange(opts: RangeOptions<string>): RangeOptions<string> {
  const out: RangeOptions<string> = { ...opts };
  if (out.gte !== undefined) out.gte = toKStr(out.gte);
  if (out.gt !== undefined) out.gt = toKStr(out.gt);
  if (out.lte !== undefined) out.lte = toKStr(out.lte);
  if (out.lt !== undefined) out.lt = toKStr(out.lt);
  return out;
}

/** Lazy one-shot candidate filter — keeps query pipelines streaming so a
 *  bounded query stops after `skip + limit` matches instead of materializing
 *  every candidate. */
export function* filterKeys(keys: Iterable<string>, pred: (k: string) => boolean): Generator<string> {
  for (const k of keys) if (pred(k)) yield k;
}
export function normDt(dt?: Record<string, number | string> | null): Record<string, number> | null {
  if (!dt) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(dt)) {
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(ms)) out[k] = ms;
  }
  return Object.keys(out).length ? out : null;
}
