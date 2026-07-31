// src/types.ts
//
// Public option and record types for the MiniDb embedded API.

import type { RangeOptions } from './skiplist.js';
import type { FsyncPolicy } from './wal.js';
import type { RecoveryMode, ValueMode } from './recovery.js';
import type { ValueCodecName } from './value-codec.js';

export type ValueModeSetting = ValueMode | 'auto';

export interface OpenOptions {
  dir: string;
  valueCodec?: ValueCodecName;
  fsyncPolicy?: FsyncPolicy;
  compactThresholdBytes?: number;
  autoCompact?: boolean;
  activeExpireIntervalMs?: number;
  recovery?: RecoveryMode;
  readOnly?: boolean;
  onLockFail?: 'readonly';
  /** Where to keep value bulk. 'memory' keeps values in RAM; 'disk' keeps only
   *  value pointers in RAM and reads values from the snapshot/WAL on demand. */
  valueMode?: ValueModeSetting;
  /** Approximate memory budget for stored keys/values. Undefined disables it. */
  maxMemoryBytes?: number;
  /** What to do when a write would exceed maxMemoryBytes. */
  maxMemoryPolicy?: 'reject' | 'evict-lru';
}

export interface RestoreOptions extends Omit<OpenOptions, 'dir'> {
  /** Overwrite an existing destination directory. */
  force?: boolean;
}

export interface SetOptions {
  ttl?: number;
  dt?: Record<string, number | string>;
}

export type BatchInputOp<V = unknown> =
  | { op: 'set'; key: string; value: V; ttl?: number; dt?: Record<string, number | string> }
  | { op: 'del'; key: string };

export interface DocRecord<V = unknown> {
  key: string;
  value: V;
  dt?: Record<string, number>;
}

export interface ScanEntry<V = unknown> extends DocRecord<V> {}

export interface QueryOptions {
  key?: string | (RangeOptions<string> & { prefix?: string });
  dt?: Record<string, RangeOptions<number>>;
  text?: { index: string; q: string; op?: 'AND' | 'OR'; limit?: number };
  filter?: Record<string, unknown>;
  project?: readonly string[];
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}
