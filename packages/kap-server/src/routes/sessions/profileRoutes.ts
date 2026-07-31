/**
 * `/sessions/{session_id}/profile` — read and update the session profile
 * (title / metadata / agent_config).
 */

import {
  IEventService,
  ISessionIndex,
  ISessionLegacyService,
  IWorkspaceService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import { updateSessionProfileRequestSchema } from '../../protocol/rest-session';
import { sessionSchema } from '../../protocol/session';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { sendMappedError } from './errors';
import { detailsSchema, sessionIdParamSchema } from './schemas';
import type { SessionRouteHost } from './types';
import { resolveSessionFacts, toWireSession } from './wire';

export function registerProfileRoutes(app: SessionRouteHost, core: Scope): void {
  const getProfileRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session profile',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(toWireSession(summary, cwd, resolveSessionFacts(core, session_id)), req.id),
      );
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const fields = await core.accessor
          .get(ISessionLegacyService)
          .updateProfile(session_id, req.body);
        const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id));
        // Broadcast the title change to every connection (including clients not
        // subscribed to this session, and covering inactive sessions), so session
        // lists stay in sync — mirrors v1's `session.meta.updated` publish.
        if (typeof req.body.title === 'string' && req.body.title.trim().length > 0) {
          core.accessor.get(IEventService).publish({
            type: 'session.meta.updated',
            payload: {
              agentId: 'main',
              sessionId: session_id,
              title: session.title,
              patch: { title: session.title, isCustomTitle: true },
            },
          });
        }
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );
}
