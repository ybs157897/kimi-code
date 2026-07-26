/**
 * Native `/api/v2` expert-team routes.
 *
 * These endpoints are intentionally separate from the compatibility
 * `/api/v1` surface. They resume the addressed Session, borrow its
 * `ISessionExpertTeamService`, and expose the independent expert-team mode
 * without adding swarm fields to legacy contracts.
 */

import {
  Error2,
  ISessionExpertTeamService,
  ISessionLifecycleService,
  type ExpertTeamDefinition,
  type ExpertTeamSnapshot,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  activateExpertTeamRequestSchema,
  deactivateExpertTeamResponseSchema,
  expertTeamSessionParamsSchema,
  getExpertTeamResponseSchema,
  listExpertTeamsResponseSchema,
} from '../protocol/rest-expertTeam';

interface ExpertTeamRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerExpertTeamsV2Routes(app: ExpertTeamRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/expert-teams',
      params: expertTeamSessionParamsSchema,
      success: { data: listExpertTeamsResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List installed expert teams available to a session',
      tags: ['expert-teams'],
      operationId: 'listExpertTeams',
    },
    async (req, reply) => {
      const service = await resolveService(core, req.params.session_id);
      if (service === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      reply.send(
        okEnvelope(
          { experts: (await service.listAvailable()).map(toWireDefinition) },
          req.id,
        ),
      );
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<ExpertTeamRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/expert-team',
      params: expertTeamSessionParamsSchema,
      success: { data: getExpertTeamResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'Get the active expert-team mode and runtime roster',
      tags: ['expert-teams'],
      operationId: 'getExpertTeam',
    },
    async (req, reply) => {
      const service = await resolveService(core, req.params.session_id);
      if (service === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      const snapshot = service.snapshot();
      reply.send(
        okEnvelope(
          { expert_team: snapshot === null ? null : toWireSnapshot(snapshot) },
          req.id,
        ),
      );
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<ExpertTeamRouteHost['get']>[2],
  );

  const activateRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/expert-team/activate',
      params: expertTeamSessionParamsSchema,
      body: activateExpertTeamRequestSchema,
      success: { data: getExpertTeamResponseSchema },
      errors: {
        [ErrorCode.REQUEST_MALFORMED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Activate a plugin-defined expert team for the session',
      tags: ['expert-teams'],
      operationId: 'activateExpertTeam',
    },
    async (req, reply) => {
      const service = await resolveService(core, req.params.session_id);
      if (service === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      try {
        const snapshot = await service.activate(req.body.plugin_id);
        reply.send(okEnvelope({ expert_team: toWireSnapshot(snapshot) }, req.id));
      } catch (error) {
        if (error instanceof Error2) {
          reply.send(errEnvelope(ErrorCode.REQUEST_MALFORMED, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.post(
    activateRoute.path,
    activateRoute.options,
    activateRoute.handler as Parameters<ExpertTeamRouteHost['post']>[2],
  );

  const deactivateRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/expert-team/deactivate',
      params: expertTeamSessionParamsSchema,
      success: { data: deactivateExpertTeamResponseSchema },
      errors: {
        [ErrorCode.REQUEST_MALFORMED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Restore the previous profile and leave expert-team mode',
      tags: ['expert-teams'],
      operationId: 'deactivateExpertTeam',
    },
    async (req, reply) => {
      const service = await resolveService(core, req.params.session_id);
      if (service === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      try {
        await service.deactivate();
        reply.send(okEnvelope({ deactivated: true as const }, req.id));
      } catch (error) {
        if (error instanceof Error2) {
          reply.send(errEnvelope(ErrorCode.REQUEST_MALFORMED, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.post(
    deactivateRoute.path,
    deactivateRoute.options,
    deactivateRoute.handler as Parameters<ExpertTeamRouteHost['post']>[2],
  );
}

async function resolveService(
  core: Scope,
  sessionId: string,
): Promise<ISessionExpertTeamService | undefined> {
  const session = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
  return session?.accessor.get(ISessionExpertTeamService);
}

function sessionNotFound(sessionId: string, requestId: string) {
  return errEnvelope(
    ErrorCode.SESSION_NOT_FOUND,
    `session ${sessionId} does not exist`,
    requestId,
  );
}

function toWireDefinition(definition: ExpertTeamDefinition) {
  return {
    plugin_id: definition.pluginId,
    plugin_version: definition.pluginVersion,
    display_name: definition.displayName,
    description: definition.description,
    profession: definition.profession,
    tags: [...definition.tags],
    lead_agent_name: definition.leadAgentName,
    member_agent_names: [...definition.memberAgentNames],
    members: definition.members.map((member) => ({
      agent: member.agent,
      role: member.role,
      display_name: member.displayName,
      name: member.name,
      profession: member.profession,
      description: member.description,
      avatar: member.avatar,
    })),
    quick_prompts: [...definition.quickPrompts],
    default_init_prompt: definition.defaultInitPrompt,
    category_id: definition.categoryId,
  };
}

function toWireSnapshot(snapshot: ExpertTeamSnapshot) {
  return {
    binding: {
      plugin_id: snapshot.binding.pluginId,
      plugin_version: snapshot.binding.pluginVersion,
      display_name: snapshot.binding.displayName,
      lead_agent_name: snapshot.binding.leadAgentName,
      lead_profile_name: snapshot.binding.leadProfileName,
      member_agent_names: [...snapshot.binding.memberAgentNames],
      previous_profile_name: snapshot.binding.previousProfile.profileName,
      activated_at: snapshot.binding.activatedAt,
    },
    team:
      snapshot.team === undefined
        ? undefined
        : {
            id: snapshot.team.id,
            name: snapshot.team.name,
            description: snapshot.team.description,
            created_at: snapshot.team.createdAt,
            members: snapshot.team.members.map((member) => ({
              name: member.name,
              agent_id: member.agentId,
              profile_name: member.profileName,
              status: member.status,
              updated_at: member.updatedAt,
              task_id: member.taskId,
            })),
          },
  };
}
