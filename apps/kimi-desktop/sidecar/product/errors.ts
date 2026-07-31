/**
 * Product facade error mapping — mirrors kap-server's per-route
 * `sendMappedError` helpers, translating engine `Error2` domain codes (plus
 * zod request-validation failures and the host-folder browser errors) onto the
 * v1 wire error codes the daemon HTTP transport returns.
 */

import { RPCError } from '@moonshot-ai/klient';
import { isError2 } from '@moonshot-ai/agent-core-v2/_base/errors/errors';
import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
} from '@moonshot-ai/agent-core-v2';

import {
  COMPACTION_UNABLE,
  FILE_NOT_FOUND,
  FILE_TOO_LARGE,
  FS_ALREADY_EXISTS,
  FS_GIT_UNAVAILABLE,
  FS_GREP_TIMEOUT,
  FS_IS_BINARY,
  FS_IS_DIRECTORY,
  FS_PATH_ESCAPES_SESSION,
  FS_PATH_NOT_FOUND,
  FS_PERMISSION_DENIED,
  FS_TOO_LARGE,
  FS_TOO_MANY_RESULTS,
  INTERNAL_ERROR,
  PROMPT_NOT_FOUND,
  REQUEST_INVALID,
  SESSION_BUSY,
  SESSION_NOT_FOUND,
  SESSION_UNDO_UNAVAILABLE,
  SKILL_NOT_ACTIVATABLE,
  SKILL_NOT_FOUND,
  TERMINAL_NOT_FOUND,
} from './constants.js';

/**
 * Mirror kap-server's `sendMappedError`: translate engine `Error2` codes to the
 * wire error codes the daemon HTTP transport returns.
 */
export function mapEngineError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (isError2(error)) {
    switch (error.code) {
      case 'session.not_found':
      case 'agent.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      case 'prompt.not_found':
        return new RPCError(PROMPT_NOT_FOUND, error.message);
      case 'session.fork_active_turn':
      case 'session.busy':
        return new RPCError(SESSION_BUSY, error.message);
      case 'compaction.unable':
        return new RPCError(COMPACTION_UNABLE, error.message);
      case 'session.undo_unavailable':
        return new RPCError(SESSION_UNDO_UNAVAILABLE, error.message);
      default:
        break;
    }
  }
  throw error;
}

/**
 * Mirror kap-server's terminals `sendMappedError` (routes/terminals.ts):
 * session/terminal not-found onto their wire codes, the uncoded
 * `Path outside workspace` assertAllowed error onto FS_PATH_ESCAPES_SESSION,
 * and zod request-validation issues onto VALIDATION_FAILED. Anything else is
 * rethrown (the host reports it as an internal error, matching the route).
 */
export function mapTerminalError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  const zodIssue = firstZodIssue(error);
  if (zodIssue !== undefined) {
    const path = zodIssue.path.map((p) => String(p)).join('.');
    const msg = path === '' ? zodIssue.message : `${path}: ${zodIssue.message}`;
    return new RPCError(REQUEST_INVALID, msg);
  }
  if (isError2(error)) {
    switch (error.code) {
      case 'session.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      case 'terminal.not_found':
        return new RPCError(TERMINAL_NOT_FOUND, error.message);
      default:
        break;
    }
  }
  if (error instanceof Error && error.message.startsWith('Path outside workspace')) {
    return new RPCError(FS_PATH_ESCAPES_SESSION, error.message);
  }
  throw error;
}

/**
 * Mirror kap-server's fs `sendMappedError` (routes/fs.ts): translate the
 * `sessionFs` + `os.fs` domain Error2 codes onto the v1 wire codes. ENOTDIR
 * collapses into path-not-found, matching the route.
 */
export function mapFsError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  const zodIssue = firstZodIssue(error);
  if (zodIssue !== undefined) {
    const path = zodIssue.path.map((p) => String(p)).join('.');
    const msg = path === '' ? zodIssue.message : `${path}: ${zodIssue.message}`;
    return new RPCError(REQUEST_INVALID, msg);
  }
  if (isError2(error)) {
    switch (error.code) {
      case 'fs.path_escapes':
        return new RPCError(FS_PATH_ESCAPES_SESSION, error.message);
      case 'fs.path_not_found':
      case 'os.fs.not_found':
      case 'os.fs.not_directory':
        return new RPCError(FS_PATH_NOT_FOUND, error.message);
      case 'fs.is_directory':
      case 'os.fs.is_directory':
        return new RPCError(FS_IS_DIRECTORY, error.message);
      case 'fs.already_exists':
      case 'os.fs.already_exists':
        return new RPCError(FS_ALREADY_EXISTS, error.message);
      case 'fs.is_binary':
        return new RPCError(FS_IS_BINARY, error.message);
      case 'fs.too_large':
        return new RPCError(FS_TOO_LARGE, error.message);
      case 'fs.too_many_results':
        return new RPCError(FS_TOO_MANY_RESULTS, error.message);
      case 'fs.grep_timeout':
        return new RPCError(FS_GREP_TIMEOUT, error.message);
      case 'fs.git_unavailable':
        return new RPCError(FS_GIT_UNAVAILABLE, error.message);
      case 'fs.permission_denied':
      case 'os.fs.permission_denied':
        return new RPCError(FS_PERMISSION_DENIED, error.message);
      case 'session.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      default:
        break;
    }
  }
  return new RPCError(
    INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Slice 5 blob-stream errors: the file store's `file.not_found` plus the
 * session fs domain codes (via mapFsError) onto the v1 wire codes — kap-server
 * files.ts / fs.ts parity (40407 / 40409 / 40906 / 41304 / 40401).
 */
export function mapBlobStreamError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (isError2(error) && error.code === 'file.not_found') {
    return new RPCError(FILE_NOT_FOUND, error.message);
  }
  return mapFsError(error);
}

/**
 * Mirror kap-server's skills `sendMappedError` (routes/skills.ts):
 * `skill.not_found` / `skill.name_empty` → 40415, `skill.type_unsupported` →
 * 40912, `turn.agent_busy` → 40901, `session.not_found` → 40401. Anything else
 * is rethrown (the host reports it as an internal error, matching the route).
 */
export function mapSkillError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (isError2(error)) {
    switch (error.code) {
      case 'skill.not_found':
      case 'skill.name_empty':
        return new RPCError(SKILL_NOT_FOUND, error.message);
      case 'skill.type_unsupported':
        return new RPCError(SKILL_NOT_ACTIVATABLE, error.message);
      case 'turn.agent_busy':
        return new RPCError(SESSION_BUSY, error.message);
      case 'session.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      default:
        break;
    }
  }
  throw error;
}

/**
 * Mirror kap-server's session-export `sendMappedError` (routes/sessionExport.ts):
 * `session.not_found` → 40401, `session.export_too_large` → 41301 (fixed
 * message), and the remaining export domain codes (`session.export_missing_version`
 * / `session.export_not_found` / `session.export_output_conflict`) → 50001.
 * Anything else is rethrown (the host reports it as an internal error).
 */
export function mapExportError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (isError2(error)) {
    switch (error.code) {
      case 'session.not_found':
        return new RPCError(SESSION_NOT_FOUND, error.message);
      case 'session.export_too_large':
        return new RPCError(FILE_TOO_LARGE, 'session export exceeds the 64 MiB web limit');
      case 'session.export_missing_version':
      case 'session.export_not_found':
      case 'session.export_output_conflict':
        return new RPCError(INTERNAL_ERROR, error.message);
      default:
        break;
    }
  }
  throw error;
}

/**
 * Mirror kap-server's workspaceFs `sendMappedError` (routes/workspaceFs.ts):
 * IHostFolderBrowser domain errors onto the folder-picker wire codes.
 */
export function mapBrowseError(error: unknown): RPCError {
  if (error instanceof RPCError) return error;
  if (error instanceof HostFolderNotAbsoluteError) {
    return new RPCError(REQUEST_INVALID, error.message);
  }
  if (error instanceof HostFolderNotFoundError) {
    return new RPCError(FS_PATH_NOT_FOUND, error.message);
  }
  if (error instanceof HostFolderPermissionError) {
    return new RPCError(FS_PERMISSION_DENIED, error.message);
  }
  throw error;
}

/**
 * Structurally detect a zod validation failure (the sidecar cannot import zod
 * directly — it is not a kimi-desktop dependency). Matches the shape the
 * request schemas throw so fs request validation maps onto VALIDATION_FAILED.
 */
function firstZodIssue(
  error: unknown,
): { path: readonly PropertyKey[]; message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  const first = issues[0] as { path?: unknown; message?: unknown } | undefined;
  if (first === undefined) return undefined;
  return {
    path: Array.isArray(first.path) ? (first.path as readonly PropertyKey[]) : [],
    message: typeof first.message === 'string' ? first.message : 'validation failed',
  };
}
