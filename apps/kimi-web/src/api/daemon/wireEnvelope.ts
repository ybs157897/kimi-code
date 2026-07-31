// apps/kimi-web/src/api/daemon/wireEnvelope.ts
// Daemon wire DTOs — shared envelope & page primitives. Part of the shared
// wire barrel (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Envelope & Page
// ---------------------------------------------------------------------------

export interface WireEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
}

export interface WirePage<T> {
  items: T[];
  has_more: boolean;
}
