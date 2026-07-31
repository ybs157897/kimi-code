// apps/kimi-web/src/api/daemon/wireFs.ts
// Daemon wire DTOs — file system entry shapes. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

export type WireFsKind = 'file' | 'directory' | 'symlink';

export interface WireFsEntry {
  path: string;
  name: string;
  kind: WireFsKind;
  size?: number;
  modified_at: string;
  etag?: string;
  mime?: string;
  language_id?: string;
  is_binary?: boolean;
  is_symlink_to?: string;
  git_status?: string;
  child_count?: number;
}
