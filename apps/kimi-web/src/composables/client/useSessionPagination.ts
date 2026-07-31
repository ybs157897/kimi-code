// apps/kimi-web/src/composables/client/useSessionPagination.ts
// Session-list pagination: per-workspace initial pages, "load more", and the
// full global walk that backs client-side search. Extracted from
// useWorkspaceState to keep each composable single-purpose.

import { getKimiWebApi } from '../../api';
import { isPlaceholderSessionUsage } from '../../api/daemon/mappers';
import type { AppSession } from '../../api/types';
import type { ExtendedState } from '../useKimiWebClient';
import {
  SESSION_PAGE_SIZE,
  SESSIONS_INITIAL_PAGE_SIZE,
  SESSIONS_LOAD_MORE_SIZE,
  SESSIONS_RECENT_WINDOW_MS,
} from './workspaceStateConstants';

export interface UseSessionPaginationDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  // rawState.sessions mutation funnel, owned by the facade — this module never
  // assigns rawState.sessions directly, it goes through this.
  setSessions: (next: AppSession[]) => void;
  workspaceIdForSession: (s: { workspaceId?: string; cwd: string }) => string;
}

export function useSessionPagination(rawState: ExtendedState, deps: UseSessionPaginationDeps) {
  const { pushOperationFailure, setSessions, workspaceIdForSession } = deps;

  /** Drain every page of sessions, newest first. A single global walk (instead of
   *  per-workspace) so sessions whose cwd is not a registered workspace root are
   *  still reachable after a refresh. A later-page failure returns the pages
   *  already fetched plus the error; only a first-page failure rejects. */
  async function listAllSessionsGlobal(): Promise<{
    sessions: AppSession[];
    error?: unknown;
  }> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    let beforeId: string | undefined;
    let continuationError: unknown;
    for (;;) {
      let page: { items: AppSession[]; hasMore: boolean };
      try {
        page = await api.listSessions({
          pageSize: SESSION_PAGE_SIZE,
          beforeId,
          excludeEmpty: true,
        });
      } catch (error) {
        if (items.length === 0) throw error;
        continuationError = error;
        break;
      }
      items.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      beforeId = page.items[page.items.length - 1]!.id;
    }
    return { sessions: items, error: continuationError };
  }

  /**
   * Replace the sessions list wholesale, preserving the live usage accumulated
   * from /status and the WS status stream: the list endpoint returns all-zero
   * placeholder usage for every session, and a blind replace would zero the
   * context ring until the next refresh.
   */
  function setSessionsPreservingLiveUsage(sessions: AppSession[]): void {
    const liveUsageById = new Map(rawState.sessions.map((s) => [s.id, s.usage] as const));
    setSessions(
      sessions.map((s) => {
        const live = liveUsageById.get(s.id);
        return live !== undefined &&
          isPlaceholderSessionUsage(s.usage) &&
          !isPlaceholderSessionUsage(live)
          ? { ...s, usage: live }
          : s;
      }),
    );
  }

  /** Keep fresh rows authoritative while retaining cached rows a partial list
   *  request never reached. */
  function mergePartialSessionsWithCached(sessions: AppSession[]): AppSession[] {
    const merged = [...sessions];
    const loadedIds = new Set(merged.map((session) => session.id));
    for (const session of rawState.sessions) {
      if (loadedIds.has(session.id)) continue;
      merged.push(session);
      loadedIds.add(session.id);
    }
    merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return merged;
  }

  /** Load the initial page of sessions for one workspace, then keep fetching
   *  older pages while the oldest loaded session is still within
   *  SESSIONS_RECENT_WINDOW_MS. Every page (including continuations) uses the
   *  small initial page size so a sparse page cannot pull in days of history at
   *  once. Continuation pages are also trimmed at the recent-window boundary,
   *  keeping only up to the first session that falls outside the window. */
  async function loadInitialSessionsForWorkspace(
    workspaceId: string,
  ): Promise<{
    workspaceId: string;
    page: { items: AppSession[]; hasMore: boolean };
    error?: unknown;
  }> {
    const api = getKimiWebApi();
    const items: AppSession[] = [];
    const now = Date.now();
    const ageOf = (s: AppSession): number => now - new Date(s.updatedAt).getTime();
    let beforeId: string | undefined;
    let hasMore = false;
    let isFirstPage = true;
    let continuationError: unknown;
    for (;;) {
      let page: { items: AppSession[]; hasMore: boolean };
      try {
        page = await api.listSessions({
          workspaceId,
          pageSize: SESSIONS_INITIAL_PAGE_SIZE,
          beforeId,
          excludeEmpty: true,
        });
      } catch (error) {
        // A failed continuation page must not discard sessions already loaded
        // from earlier pages; only a page-1 failure rejects the workspace load.
        if (isFirstPage) throw error;
        continuationError = error;
        hasMore = true;
        break;
      }
      hasMore = page.hasMore;
      if (page.items.length === 0) break;
      const oldest = page.items[page.items.length - 1]!;
      const oldestBeyondWindow = ageOf(oldest) >= SESSIONS_RECENT_WINDOW_MS;

      if (!isFirstPage && oldestBeyondWindow) {
        // This continuation page crosses the recent-window boundary. Keep only
        // up to and including the first session that falls outside the window
        // (so the oldest loaded is the first one older than the window) and
        // drop the older tail instead of loading the whole page.
        const boundaryIndex = page.items.findIndex(
          (s) => ageOf(s) >= SESSIONS_RECENT_WINDOW_MS,
        );
        const keep = boundaryIndex >= 0 ? boundaryIndex + 1 : page.items.length;
        items.push(...page.items.slice(0, keep));
        hasMore = page.hasMore || keep < page.items.length;
        break;
      }

      items.push(...page.items);
      isFirstPage = false;
      if (!page.hasMore || oldestBeyondWindow) break;
      beforeId = oldest.id;
    }
    return { workspaceId, page: { items, hasMore }, error: continuationError };
  }

  /** Fetch the first page of sessions for every known workspace concurrently.
   *  Returns the merged, recency-sorted list and seeds per-workspace hasMore.
   *  When every workspace request fails, returns undefined so the caller keeps
   *  the previously loaded sessions instead of committing a false empty list. */
  async function loadInitialSessionsByWorkspace(): Promise<AppSession[] | undefined> {
    const workspaces = rawState.workspaces;
    if (workspaces.length === 0) {
      // /workspaces may be unavailable or empty on older / partially-failing
      // daemons while /sessions still works. Fall back to the legacy global
      // walk so history still shows and mergedWorkspaces can derive workspaces
      // from session cwds, instead of rendering a blank sidebar.
      const fallback = await listAllSessionsGlobal();
      const sessions =
        fallback.error === undefined
          ? fallback.sessions
          : mergePartialSessionsWithCached(fallback.sessions);
      rawState.sessionsHasMoreByWorkspace = {};
      rawState.sessionsCursorByWorkspace = {};
      rawState.sessionsInitialCountByWorkspace = {};
      rawState.sessionsFullyLoaded = fallback.error === undefined;
      if (fallback.error !== undefined) pushOperationFailure('load', fallback.error);
      return sessions;
    }
    const results = await Promise.allSettled(
      workspaces.map((w) => loadInitialSessionsForWorkspace(w.id)),
    );
    const loaded: AppSession[] = [];
    const loadedIds = new Set<string>();
    const successfulPages = new Map<string, { items: AppSession[]; hasMore: boolean }>();
    const failedWorkspaceIds = new Set<string>();
    let firstError: unknown;
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === 'fulfilled') {
        successfulPages.set(result.value.workspaceId, result.value.page);
        if (result.value.error !== undefined) {
          if (failedWorkspaceIds.size === 0) firstError = result.value.error;
          failedWorkspaceIds.add(result.value.workspaceId);
        }
        for (const session of result.value.page.items) {
          if (loadedIds.has(session.id)) continue;
          loaded.push(session);
          loadedIds.add(session.id);
        }
        continue;
      }
      if (failedWorkspaceIds.size === 0) firstError = result.reason;
      failedWorkspaceIds.add(workspaces[index]!.id);
    }

    // One failed workspace must not erase another workspace's successful page,
    // nor the failed workspace's last usable rows. If every request failed,
    // leave both sessions and pagination state untouched for a natural retry.
    if (successfulPages.size === 0) {
      pushOperationFailure('load', firstError);
      return undefined;
    }
    const failedWorkspaceRoots = new Set(
      workspaces
        .filter((workspace) => failedWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.root),
    );
    const registeredWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const session of rawState.sessions) {
      const belongsToFailedWorkspace =
        session.workspaceId !== undefined && registeredWorkspaceIds.has(session.workspaceId)
          ? failedWorkspaceIds.has(session.workspaceId)
          : failedWorkspaceRoots.has(session.cwd) ||
            failedWorkspaceIds.has(workspaceIdForSession(session));
      if (!belongsToFailedWorkspace || loadedIds.has(session.id)) continue;
      loaded.push(session);
      loadedIds.add(session.id);
    }

    const hasMore: Record<string, boolean> = {};
    const cursors: Record<string, string | undefined> = {};
    const counts: Record<string, number> = {};
    for (const { id: workspaceId } of workspaces) {
      const page = successfulPages.get(workspaceId);
      if (page === undefined) {
        const previousHasMore = rawState.sessionsHasMoreByWorkspace[workspaceId];
        const previousCursor = rawState.sessionsCursorByWorkspace[workspaceId];
        const previousCount = rawState.sessionsInitialCountByWorkspace[workspaceId];
        if (previousHasMore !== undefined) hasMore[workspaceId] = previousHasMore;
        if (previousCursor !== undefined) cursors[workspaceId] = previousCursor;
        if (previousCount !== undefined) counts[workspaceId] = previousCount;
        continue;
      }
      // Trust the server's hasMore — the per-workspace session_count is only a
      // (possibly stale) label total, not an authority on whether more pages exist.
      hasMore[workspaceId] = page.hasMore;
      // Cursor = oldest session of this page (pages are newest-first). Tracked
      // separately from the loaded set so a deep-linked older session appended
      // out of band cannot shift the cursor and skip intervening sessions.
      cursors[workspaceId] =
        page.items.length > 0 ? page.items[page.items.length - 1]!.id : undefined;
      // Collapse target for the sidebar's in-group "show less" control: the
      // first-page capacity, floored at a full page so a workspace that was
      // empty or sparse on first paint does not hide sessions created later.
      // If the initial load pulled more than a page (recent-window
      // continuations), keep the larger count so collapse returns to what was
      // first visible.
      counts[workspaceId] = Math.max(page.items.length, SESSIONS_INITIAL_PAGE_SIZE);
    }
    rawState.sessionsHasMoreByWorkspace = hasMore;
    rawState.sessionsCursorByWorkspace = cursors;
    rawState.sessionsInitialCountByWorkspace = counts;
    rawState.sessionsFullyLoaded = false;
    // Keep rawState.sessions newest-first for readers that pick sessions[0]
    // (e.g. auto-selecting the most recent session on first load).
    loaded.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (failedWorkspaceIds.size > 0) pushOperationFailure('load', firstError);
    return loaded;
  }

  /** Fetch the next page of sessions for a workspace (the "load more" button). */
  async function loadMoreSessions(workspaceId: string): Promise<void> {
    if (rawState.sessionsLoadingMoreByWorkspace[workspaceId]) return;
    if (rawState.sessionsHasMoreByWorkspace[workspaceId] === false) return;
    const beforeId = rawState.sessionsCursorByWorkspace[workspaceId];
    if (beforeId === undefined) return;
    rawState.sessionsLoadingMoreByWorkspace = {
      ...rawState.sessionsLoadingMoreByWorkspace,
      [workspaceId]: true,
    };
    try {
      const page = await getKimiWebApi().listSessions({
        workspaceId,
        pageSize: SESSIONS_LOAD_MORE_SIZE,
        beforeId,
        excludeEmpty: true,
      });
      // Append de-duped against the latest list so a concurrently added/removed
      // session is respected.
      const existing = new Set(rawState.sessions.map((s) => s.id));
      const fresh = page.items.filter((s) => !existing.has(s.id));
      if (fresh.length > 0) setSessions([...rawState.sessions, ...fresh]);
      // Advance the cursor to the end of the page we just fetched.
      rawState.sessionsCursorByWorkspace = {
        ...rawState.sessionsCursorByWorkspace,
        [workspaceId]:
          page.items.length > 0 ? page.items[page.items.length - 1]!.id : beforeId,
      };
      // Trust the server's hasMore. Deriving it from the workspace session_count
      // is unsafe: archive/delete only removes the local session and leaves the
      // count stale, which would keep hasMore true and re-fetch empty pages.
      rawState.sessionsHasMoreByWorkspace = {
        ...rawState.sessionsHasMoreByWorkspace,
        [workspaceId]: page.hasMore,
      };
    } catch (err) {
      pushOperationFailure('loadMoreSessions', err);
    } finally {
      rawState.sessionsLoadingMoreByWorkspace = {
        ...rawState.sessionsLoadingMoreByWorkspace,
        [workspaceId]: false,
      };
    }
  }

  /** Drain every session via a single global walk so client-side search covers
   *  all sessions, not just the first page per workspace. Triggered lazily on
   *  first search; a no-op once the full list is loaded. */
  async function loadAllSessions(): Promise<void> {
    if (rawState.sessionsFullyLoaded) return;
    const result = await listAllSessionsGlobal().catch((err) => {
      console.warn('[kimi-web] loadAllSessions failed; search covers only loaded sessions', err);
      return null;
    });
    if (result === null) return;
    const sessions =
      result.error === undefined
        ? result.sessions
        : mergePartialSessionsWithCached(result.sessions);
    setSessionsPreservingLiveUsage(sessions);
    rawState.sessionsFullyLoaded = result.error === undefined;
    if (result.error !== undefined) return;
    const cleared: Record<string, boolean> = {};
    for (const w of rawState.workspaces) cleared[w.id] = false;
    rawState.sessionsHasMoreByWorkspace = cleared;
  }

  return {
    listAllSessionsGlobal,
    setSessionsPreservingLiveUsage,
    loadInitialSessionsByWorkspace,
    loadMoreSessions,
    loadAllSessions,
  };
}
