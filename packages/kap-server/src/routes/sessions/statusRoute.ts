/**
 * `GET /sessions/{session_id}/status` — realtime session status (best-effort,
 * via `ISessionLegacyService`).
 */

import { ISessionLegacyService, type Scope } from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import { sessionStatusResponseSchema } from '../../protocol/rest-session';

import { okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { sendMappedError } from './errors';
import { detailsSchema, sessionIdParamSchema } from './schemas';
import type { SessionRouteHost } from './types';

export function registerStatusRoute(app: SessionRouteHost, core: Scope): void {
  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/status',
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get realtime session status (best-effort in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const status = await core.accessor.get(ISessionLegacyService).status(session_id);
        reply.send(okEnvelope(status, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}
