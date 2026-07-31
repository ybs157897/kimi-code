// apps/kimi-web/src/api/desktop/wire.ts
// Desktop client wire DTOs — shapes NOT in the shared daemon wire.ts,
// mirrored field-for-field from the daemon client's local DTOs
// (daemon/client.ts). Fields stay snake_case as they appear on the wire;
// mappers.ts (and ../daemon/mappers.ts) do the camelCase conversions.

import type { FsKind } from '../types';
import type { WireFsEntry } from '../daemon/wire';

// ---------------------------------------------------------------------------
// Wire response shapes for boot endpoints not in shared wire.ts — mirrored
// field-for-field from the daemon client's local DTOs (daemon/client.ts), which
// in turn match the kap-server healthz / meta routes.
// ---------------------------------------------------------------------------

export interface WireHealth {
  status: 'ok';
  uptime_sec: number;
}

export interface WireMeta {
  server_version: string;
  server_id: string;
  started_at: string;
  capabilities: Record<string, boolean>;
  open_in_apps?: string[];
  dangerous_bypass_auth?: boolean;
  /** Engine generation serving the API; older (v1) servers omit the field. */
  backend?: 'v1' | 'v2';
}

// ---------------------------------------------------------------------------
// Slice 4 — structured filesystem wire results. Mirrored field-for-field from
// the daemon client's local DTOs (daemon/client.ts), which match the engine's
// `sessionFs` response schemas the sidecar returns unchanged.
// ---------------------------------------------------------------------------

export interface WireListDirectoryResult {
  items: WireFsEntry[];
  children_by_path?: Record<string, WireFsEntry[]>;
  truncated: boolean;
}

export interface WireReadFileResult {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  truncated: boolean;
  etag: string;
  mime: string;
  language_id?: string;
  line_count?: number;
  is_binary: boolean;
}

export interface WireSearchFilesResult {
  items: Array<{
    path: string;
    name: string;
    kind: FsKind;
    score: number;
    match_positions: number[];
  }>;
  truncated: boolean;
}

export interface WireGrepFilesResult {
  files: Array<{
    path: string;
    matches: Array<{
      line: number;
      col: number;
      text: string;
      before: string[];
      after: string[];
    }>;
  }>;
  files_scanned: number;
  truncated: boolean;
  elapsed_ms: number;
}

export interface WireDiffResult {
  path: string;
  diff: string;
}

// ---------------------------------------------------------------------------
// Slice 6 — session terminals. Mirrored field-for-field from the daemon
// client's local DTO (daemon/clientWire.ts `WireTerminal`); there is no shared
// wire.ts entry, so the desktop client keeps its own copy matching the
// sidecar's kap-server-parity wire exactly.
// ---------------------------------------------------------------------------

export interface WireTerminal {
  id: string;
  session_id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  created_at: string;
  exited_at?: string;
  exit_code?: number | null;
}

// ---------------------------------------------------------------------------
// Slice 7 — skills, code extensions. Mirrored field-for-field from the daemon
// client's local DTOs (daemon/clientWire.ts `WireSkillDescriptor` /
// `WireExtensionCommand` / `WireExtensionReloadResult`), matching the sidecar's
// kap-server-parity wire exactly.
// ---------------------------------------------------------------------------

export interface WireSkillDescriptor {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

export interface WireExtensionCommand {
  extension_id: string;
  name: string;
  description: string;
}

export interface WireExtensionReloadResult {
  active: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * The v2 sync control frame the product stream pushes (instead of a `WireEvent`)
 * when it cannot incrementally cover the resume cursor. Mirrors the sidecar's
 * `WireResyncRequired` and kimi-web's daemon `WireResyncRequired`; the desktop
 * client discriminates it on `type` before mapping normal events.
 */
export interface DesktopResyncFrame {
  type: 'resync_required';
  timestamp?: string;
  payload: {
    session_id: string;
    reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed';
    current_seq: number;
    epoch?: string;
  };
}
