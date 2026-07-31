// apps/kimi-web/src/composables/client/useWorkspaceFiles.ts
// Workspace file operations: diff viewing, git status, directory listing,
// file reading/downloading, external-app open, image resolution, and search.
// Extracted from useWorkspaceState to keep each composable single-purpose.

import type { ComputedRef, Ref } from 'vue';
import { getKimiWebApi } from '../../api';
import type { FsEntry } from '../../api/types';
import { parseDiff } from '../../lib/parseDiff';
import type { ConversationStatus, DiffViewLine } from '../../types';
import type { ExtendedState } from '../useKimiWebClient';

export interface UseWorkspaceFilesDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  status: ComputedRef<ConversationStatus>;
  selectedDiffPath: Ref<string | null>;
  fileDiffLines: Ref<DiffViewLine[]>;
  fileDiffLoading: Ref<boolean>;
}

export interface UseWorkspaceFiles {
  loadFileDiff: (path: string) => Promise<void>;
  clearFileDiff: () => void;
  loadGitStatus: (sessionId: string) => Promise<void>;
  listDir: (path?: string) => Promise<FsEntry[]>;
  readFileContent: (path: string) => Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mime: string;
    languageId?: string;
    isBinary: boolean;
    size: number;
    lineCount?: number;
  } | null>;
  getFileDownloadUrl: (path: string) => string | null;
  getWorkspaceFileBlob: (path: string) => Promise<Blob | null>;
  openWorkspaceFile: (path: string, line?: number) => Promise<boolean>;
  openInApp: (appId: string) => Promise<void>;
  revealWorkspaceFile: (path: string) => Promise<boolean>;
  resolveImageUrl: (src: string) => Promise<string>;
  searchFiles: (query: string) => Promise<Array<{ path: string; name: string }>>;
}

// Matches the daemon's FS_READ_MAX_BYTES. Without an explicit length the
// protocol defaults to 1MiB and silently truncates — half a PNG decodes as a
// broken image, which is worse than falling back to the original src.
const IMAGE_READ_MAX_BYTES = 10_485_760;

export function useWorkspaceFiles(
  rawState: ExtendedState,
  deps: UseWorkspaceFilesDeps,
): UseWorkspaceFiles {
  const { pushOperationFailure, status, selectedDiffPath, fileDiffLines, fileDiffLoading } = deps;

  async function loadFileDiff(path: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    selectedDiffPath.value = path;
    fileDiffLines.value = [];
    fileDiffLoading.value = true;
    try {
      const api = getKimiWebApi();
      const result = await api.getFileDiff(sid, path);
      // Guard against a stale response when the user tapped another file.
      if (selectedDiffPath.value !== path) return;
      fileDiffLines.value = parseDiff(result.diff);
    } catch (err) {
      // A single file's diff failing (a new/untracked/binary/deleted file the
      // daemon can't diff) is LOCAL to this pane, not a session-level fault — the
      // DiffView already shows a graceful "no diff" state when the lines are
      // empty. Surfacing it as a global "kimi server api" error toast on a routine
      // file click is disproportionate, so log it for the trace export instead.
      if (selectedDiffPath.value === path) fileDiffLines.value = [];
      console.warn('[loadFileDiff] diff unavailable for', path, err);
    } finally {
      if (selectedDiffPath.value === path) fileDiffLoading.value = false;
    }
  }

  /** Close the ~/diff line-by-line view and return to the changed-file list. */
  function clearFileDiff(): void {
    selectedDiffPath.value = null;
    fileDiffLines.value = [];
    fileDiffLoading.value = false;
  }

  /** Load git status for a session — defensive, never throws */
  async function loadGitStatus(sessionId: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      const result = await api.getGitStatus(sessionId);
      rawState.gitStatusBySession = {
        ...rawState.gitStatusBySession,
        [sessionId]: result,
      };
    } catch {
      // Stale/old sessions may 404 — leave undefined, no crash
    }
  }

  async function listDir(path = ''): Promise<FsEntry[]> {
    const sid = rawState.activeSessionId;
    if (!sid) return [];
    try {
      const api = getKimiWebApi();
      const result = await api.listDirectory(sid, {
        path: path || undefined,
        includeGitStatus: true,
      });
      return result.items;
    } catch {
      return [];
    }
  }

  /**
   * Read file content for the active session.
   * Returns the file metadata + content (including path), or null on error or no active session.
   */
  async function readFileContent(path: string): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mime: string;
    languageId?: string;
    isBinary: boolean;
    size: number;
    lineCount?: number;
  } | null> {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, { path });
      return {
        path: result.path,
        content: result.content,
        encoding: result.encoding,
        mime: result.mime,
        languageId: result.languageId,
        isBinary: result.isBinary,
        size: result.size,
        lineCount: result.lineCount,
      };
    } catch (err) {
      console.warn('[kimi-web] readFileContent failed for', path, err);
      return null;
    }
  }

  function getFileDownloadUrl(path: string): string | null {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    // Desktop transports cannot produce a fetchable URL — the caller falls
    // back to getWorkspaceFileBlob + URL.createObjectURL.
    if (!(getKimiWebApi().supportsSyncFileUrls?.() ?? true)) return null;
    return getKimiWebApi().getFileDownloadUrl(sid, path);
  }

  /** Fetch a workspace file's bytes (the blob counterpart of getFileDownloadUrl). */
  async function getWorkspaceFileBlob(path: string): Promise<Blob | null> {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    try {
      return await getKimiWebApi().getWorkspaceFileBlob(sid, path);
    } catch (err) {
      pushOperationFailure('downloadFile', err, { sessionId: sid });
      return null;
    }
  }

  async function openWorkspaceFile(path: string, line?: number): Promise<boolean> {
    const sid = rawState.activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().openFile(sid, { path, line });
      return true;
    } catch (err) {
      pushOperationFailure('openFile', err, { sessionId: sid });
      return false;
    }
  }

  /** Open the current workspace in an external application (Finder, Cursor, etc.). */
  async function openInApp(appId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const path = status.value.cwd || '.';
    try {
      await getKimiWebApi().openInApp(sid, appId, path);
    } catch (err) {
      pushOperationFailure('openInApp', err, { sessionId: sid });
    }
  }

  async function revealWorkspaceFile(path: string): Promise<boolean> {
    const sid = rawState.activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().revealFile(sid, { path });
      return true;
    } catch (err) {
      pushOperationFailure('revealFile', err, { sessionId: sid });
      return false;
    }
  }

  /**
   * Resolve a local image path to a displayable data URL.
   * Non-local URLs (http/https/data) pass through unchanged.
   * Local paths are read via the daemon's readFile endpoint and returned as
   * data:{mime};base64,{content} URLs so they render in the browser. Absolute
   * paths are made cwd-relative first (the daemon rejects absolute paths), and
   * truncated/non-binary reads fall back to the original src.
   */
  async function resolveImageUrl(src: string): Promise<string> {
    // Pass through already-addressable URLs
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const sid = rawState.activeSessionId;
    if (!sid) return src;

    // The daemon's path resolution only accepts session-relative paths, but the
    // model usually references images by absolute path. Strip the session cwd.
    let path = src;
    if (path.startsWith('/')) {
      const cwd = rawState.sessions.find((s) => s.id === sid)?.cwd;
      if (cwd && (path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`))) {
        path = path.slice(cwd.length).replace(/^\//, '');
        if (!path) return src;
      } else {
        return src; // absolute path outside the workspace — unreadable
      }
    }

    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, { path, length: IMAGE_READ_MAX_BYTES });
      if (!result.isBinary || result.encoding !== 'base64' || result.truncated) return src;
      return `data:${result.mime};base64,${result.content}`;
    } catch {
      return src;
    }
  }

  /**
   * Search files in the active session using the daemon searchFiles endpoint.
   * Returns {path, name}[] — defensive, returns [] on error or no active session.
   */
  async function searchFiles(query: string): Promise<Array<{ path: string; name: string }>> {
    const sid = rawState.activeSessionId;
    if (!sid) return [];
    try {
      const api = getKimiWebApi();
      const result = await api.searchFiles(sid, { query, limit: 20 });
      return result.items.map((item) => ({ path: item.path, name: item.name }));
    } catch {
      return [];
    }
  }

  return {
    loadFileDiff,
    clearFileDiff,
    loadGitStatus,
    listDir,
    readFileContent,
    getFileDownloadUrl,
    getWorkspaceFileBlob,
    openWorkspaceFile,
    openInApp,
    revealWorkspaceFile,
    resolveImageUrl,
    searchFiles,
  };
}
