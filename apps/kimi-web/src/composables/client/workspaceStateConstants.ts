// apps/kimi-web/src/composables/client/workspaceStateConstants.ts
// Pagination + timing constants shared by useWorkspaceState and the
// sub-composables extracted from it (session pagination, auth bootstrap).

export const MESSAGES_PAGE_SIZE = 50;
// Sessions fetched per workspace on first load — keeps the initial request
// count at (number of workspaces) and each response small. Exported so the
// sidebar can fall back to it when a workspace's first-page size is unknown.
export const SESSIONS_INITIAL_PAGE_SIZE = 5;

// First load polls /auth until it gives a definitive answer (see load()).
export const FIRST_LOAD_AUTH_RETRY_MS = 2000;

// Backend max page size for GET /sessions. Bigger pages mean fewer round-trips
// when draining the full session list.
export const SESSION_PAGE_SIZE = 100;
// Sessions fetched per "load more" click within a workspace.
export const SESSIONS_LOAD_MORE_SIZE = 30;
// On initial load, if the oldest session of the first page is still within
// this window, keep fetching older pages until the oldest loaded session falls
// outside it. Avoids clipping an active workspace's history at an arbitrary
// 5-session boundary when it has a run of recently-updated sessions.
export const SESSIONS_RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;
