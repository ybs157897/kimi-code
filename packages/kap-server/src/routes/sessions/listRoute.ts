/**
 * `GET /sessions` — list sessions with id-cursor pagination and busy /
 * archive / workspace filters.
 */

import {
  ISessionIndex,
  IWorkspaceAliases,
  IWorkspaceService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import { pageResponseSchema } from '../../protocol/pagination';
import { sessionSchema, type Session } from '../../protocol/session';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { DEFAULT_SESSION_LIST_PAGE_SIZE, detailsSchema, sessionsListQueryCoercion } from './schemas';
import type { SessionRouteHost } from './types';
import { resolveSessionFacts, toWireSession, type SessionFacts } from './wire';

export function registerListRoute(app: SessionRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const pageSize = raw.page_size;
      const archivedOnly = raw.archived_only === true;

      const workspaces = await core.accessor.get(IWorkspaceService).list();
      const roots = new Map(workspaces.map((w) => [w.id, w.root]));

      // v1 resolves `workspace_id` to its root and 40410s when it is unknown;
      // the existence check stays on the listed (root-deduped) registry so an
      // unknown id fails byte-identically, and only then is a known id
      // expanded to every id spelling of the same directory — legacy split
      // buckets (casing/slash variants) list as one workspace.
      if (raw.workspace_id !== undefined && !roots.has(raw.workspace_id)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      // `FileSessionIndex` does not implement `cursor` (gap G5 closed here), so
      // we fetch the full recency-sorted set (no `limit`) and apply the id
      // cursor in this handler. `list()` already orders by `updatedAt` desc and
      // filters across the workspace-id set / archived. `archived_only` forces
      // archived rows into the set, then the filter below keeps only them.
      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(raw.workspace_id);
      const page = await core.accessor.get(ISessionIndex).list({
        workspaceIds,
        includeArchived: archivedOnly ? true : raw.include_archive,
      });

      // Filter down to the sequence the client can page over BEFORE computing
      // the cursor position. `cwd` is read from the session's own summary first
      // (gap G3 closed — an unregistered workspace no longer drops the session);
      // the registry `roots` map is only a back-compat fallback for sessions
      // written before `cwd` was persisted. A session with no recoverable cwd is
      // still skipped.
      const eligible: {
        readonly summary: (typeof page.items)[number];
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }[] = [];
      for (const summary of page.items) {
        const cwd = summary.cwd ?? roots.get(summary.workspaceId);
        if (cwd === undefined) continue;
        if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
        eligible.push({ summary, cwd });
      }

      // `before_id` = strictly older than this id (forward / default paging);
      // `after_id` = strictly newer. An unknown cursor resolves to an empty,
      // terminal page (`has_more: false`) so a client cannot spin on a cursor
      // the server cannot advance (this was the boot-time request storm).
      let start = 0;
      let end = eligible.length;
      const cursorId = raw.before_id ?? raw.after_id;
      if (cursorId !== undefined) {
        const idx = eligible.findIndex((e) => e.summary.id === cursorId);
        if (idx === -1) {
          reply.send(okEnvelope({ items: [], has_more: false }, req.id));
          return;
        }
        if (raw.before_id !== undefined) start = idx + 1;
        else end = idx;
      }

      const window = eligible.slice(start, end);
      let visible = window;
      if (archivedOnly) {
        visible =
          raw.busy === undefined
            ? window.filter((entry) => entry.summary.archived === true)
            : window.flatMap((entry) => {
                if (entry.summary.archived !== true) return [];
                const facts = resolveSessionFacts(core, entry.summary.id);
                return facts.busy === raw.busy ? [{ ...entry, facts }] : [];
              });
      }
      const limit = archivedOnly
        ? (pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE)
        : (pageSize ?? visible.length);
      const hasMore = visible.length > limit;
      const projected: Session[] = visible
        .slice(0, limit)
        .map(({ summary, cwd, facts }) =>
          toWireSession(summary, cwd, facts ?? resolveSessionFacts(core, summary.id)),
        );
      // v1 filters ordinary lists by the busy fact post-page; `archived_only`
      // already applied it before pagination above so it can drain to a full page.
      const items =
        raw.busy !== undefined && !archivedOnly
          ? projected.filter((session) => session.busy === raw.busy)
          : projected;
      reply.send(okEnvelope({ items, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}
