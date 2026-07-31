// apps/kimi-web/src/api/daemon/clientWire.ts
// Wire response shapes for daemon endpoints not in shared wire.ts.

import type { WireFsEntry } from './wire';

// ---------------------------------------------------------------------------
// Wire response shapes for endpoints not in shared wire.ts
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

export interface WireAbortResult {
  aborted: boolean;
  at_seq?: number;
}

export interface WireDismissResult {
  dismissed: boolean;
  dismissed_at: string;
}

export interface WireApprovalResolveResult {
  resolved: true;
  resolved_at: string;
}

export interface WireQuestionResolveResult {
  resolved: true;
  resolved_at: string;
}

export interface WireCancelResult {
  cancelled: true;
}

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

export interface WireArchiveResult {
  archived: true;
}

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
    kind: 'file' | 'directory' | 'symlink';
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

export interface WireGitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest?: { number: number; state: string; url: string } | null;
}

export interface WireDiffResult {
  path: string;
  diff: string;
}

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
