/**
 * `/sessions/{session_id}/children` — list child sessions and create a child
 * session (fork + child markers).
 */

import {
  Error2,
  ErrorCodes,
  IEventService,
  ISessionContext,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import {
  createSessionChildRequestSchema,
  listSessionChildrenResponseSchema,
} from '../../protocol/rest-session';
import { sessionSchema } from '../../protocol/session';

import { okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { sendMappedError } from './errors';
import { detailsSchema, sessionChildrenListQueryCoercion, sessionIdParamSchema } from './schemas';
import type { SessionRouteHost } from './types';
import { resolveSessionFacts, toWireSession } from './wire';

export function registerChildrenRoutes(app: SessionRouteHost, core: Scope): void {
  const listChildrenRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List child sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // 404 when the parent is unknown — the live handle wins, otherwise the
        // persisted index (a closed parent can still list children, like v1).
        const exists =
          core.accessor.get(ISessionLifecycleService).get(session_id) !== undefined ||
          (await core.accessor.get(ISessionIndex).get(session_id)) !== undefined;
        if (!exists) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }

        // The index filters by the child markers (`parent_session_id` +
        // `child_session_kind`) and returns the recency-sorted children. The
        // id-cursor, page-size, and status projection/filter stay at the edge
        // (v1 wire concerns; status needs live handles).
        const children = (await core.accessor.get(ISessionIndex).list({ childOf: session_id }))
          .items;

        let pivotIndex = -1;
        if (req.query.before_id !== undefined) {
          pivotIndex = children.findIndex((s) => s.id === req.query.before_id);
        } else if (req.query.after_id !== undefined) {
          pivotIndex = children.findIndex((s) => s.id === req.query.after_id);
        }
        let slice: typeof children;
        if (req.query.before_id !== undefined && pivotIndex >= 0) {
          slice = children.slice(pivotIndex + 1);
        } else if (req.query.after_id !== undefined && pivotIndex >= 0) {
          slice = children.slice(0, pivotIndex);
        } else {
          slice = children;
        }
        // `page_size` is already clamped to [1, 100] by the query coercion; 100
        // is the v1 default when omitted.
        const pageSize = req.query.page_size ?? 100;
        const window = slice.slice(0, pageSize);

        // `cwd` is read from the child's own summary first (gap G3 closed); the
        // registry is only a back-compat fallback for sessions written before
        // `cwd` was persisted, defaulting to '' (matches the prior adapter).
        const roots = new Map(
          (await core.accessor.get(IWorkspaceService).list()).map((w) => [w.id, w.root]),
        );
        const projected = window.map((summary) =>
          toWireSession(
            summary,
            summary.cwd ?? roots.get(summary.workspaceId) ?? '',
            resolveSessionFacts(core, summary.id),
          ),
        );
        // v1 filters the projected page by the busy fact (post-page); `has_more`
        // reflects the pre-filter page.
        const items =
          req.query.busy !== undefined
            ? projected.filter((session) => session.busy === req.query.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: slice.length > pageSize }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const createChildRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: 'Create a child session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        // `createChild` throws `session.not_found` for an unknown source (via
        // `fork`), so no explicit existence check is needed here. The child
        // markers (`parent_session_id` / `child_session_kind`) and the default
        // `Child: <parent>` title are applied by the lifecycle.
        const handle = await core.accessor.get(ISessionLifecycleService).createChild({
          sourceSessionId: session_id,
          title: req.body.title,
          metadata: req.body.metadata,
        });
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const ctx = handle.accessor.get(ISessionContext);
        const session = toWireSession(
          { ...meta, workspaceId: ctx.workspaceId },
          ctx.cwd,
          resolveSessionFacts(core, meta.id),
        );
        core.accessor.get(IEventService).publish({
          type: 'event.session.created',
          payload: { agentId: 'main', sessionId: session.id, session },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );
}
