// src/index.ts
//
// MiniDb: the public embedded API. Ties together the in-memory Store (with its
// ordered key index), the WAL, recovery, compaction, dt-column indexes, value
// secondary indexes, and full-text indexes.
//
// Document model:
//   { key: string(<=128), value: <any JSON>, dt1..dtN: <epoch-ms datetime columns> }
//
// This is the public entry point: a thin barrel that re-exports the API from
// its implementation submodules — value codecs (./value-codec), key
// normalization (./keys), public types (./types), filesystem helpers
// (./fs-util), and the MiniDb class (./minidb).

export { UniqueViolationError } from './index-manager.js';
export { LockError } from './lockfile.js';
export type { RecoveryInfo } from './recovery.js';
export type { IndexDef, IndexInfo, IndexType } from './index-manager.js';
export type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
export type { ValueCodecName, ValueCodec } from './value-codec.js';
export type {
  ValueModeSetting,
  OpenOptions,
  RestoreOptions,
  SetOptions,
  BatchInputOp,
  DocRecord,
  ScanEntry,
  QueryOptions,
} from './types.js';
export { MiniDb } from './minidb.js';
// ClusterDb (the multi-process sharding layer) lives at the './cluster'
// subpath export to keep this module free of import cycles.
