/**
 * `GET /sessions/{session_id}/goal` — the current session goal (null when
 * none is active), via `ISessionLegacyService`.
 */

import { ISessionLegacyService, type Scope } from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import { getSessionGoalResponseSchema } from '../../protocol/rest-session';

import { okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { sendMappedError } from './errors';
import { detailsSchema, sessionIdParamSchema } from './schemas';
import type { SessionRouteHost } from './types';

export function registerGoalRoute(app: SessionRouteHost, core: Scope): void {
  const goalRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/goal',
      params: sessionIdParamSchema,
      success: { data: getSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get the current session goal (null when none is active)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const goal = await core.accessor.get(ISessionLegacyService).goal(session_id);
        reply.send(okEnvelope(goal, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    goalRoute.path,
    goalRoute.options,
    goalRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}
