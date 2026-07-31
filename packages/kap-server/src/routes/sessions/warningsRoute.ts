/**
 * `GET /sessions/{session_id}/warnings` — session-level notices in the v1
 * `{ code, message, severity }` wire shape (oversized AGENTS.md, secondary
 * model early-validation).
 */

import {
  IAgentProfileService,
  ISessionLifecycleService,
  ISessionSecondaryModelWarningService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import { sessionWarningsResponseSchema } from '../../protocol/rest-session';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { ensureMainAgent } from '../../transport/mainAgent';
import { sendMappedError } from './errors';
import { detailsSchema, sessionIdParamSchema } from './schemas';
import type { SessionRouteHost } from './types';

export function registerWarningsRoute(app: SessionRouteHost, core: Scope): void {
  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      // `resume` (not `get`) so a freshly-opened cold session still computes its
      // warnings; matches v1's best-effort `resumeSession` before reading them.
      const session = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      try {
        // Surface v2 notices in the v1 wire shape. The agents-md warning is
        // computed (and cached) by `IAgentProfileService` when the main agent
        // binds a profile; the secondary-model warning is computed (and
        // cached) by `ISessionSecondaryModelWarningService` when the main
        // agent is created. An unbound main agent / unset secondary model
        // yields `undefined` → that entry drops out, matching v1's "no
        // warning" case.
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
        const secondaryModelWarning = session.accessor
          .get(ISessionSecondaryModelWarningService)
          .getSecondaryModelWarning();
        const warnings = [
          ...(agentsMdWarning === undefined
            ? []
            : [
                {
                  code: 'agents-md-oversized',
                  message: agentsMdWarning,
                  severity: 'warning' as const,
                },
              ]),
          ...(secondaryModelWarning === undefined
            ? []
            : [
                {
                  code: secondaryModelWarning.code,
                  message: secondaryModelWarning.message,
                  severity: 'warning' as const,
                },
              ]),
        ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}
