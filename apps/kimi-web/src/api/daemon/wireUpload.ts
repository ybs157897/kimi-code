// apps/kimi-web/src/api/daemon/wireUpload.ts
// Daemon wire DTOs — uploaded file metadata. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// File upload wire DTOs
// ---------------------------------------------------------------------------

export interface WireFileMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
  expires_at?: string;
}
