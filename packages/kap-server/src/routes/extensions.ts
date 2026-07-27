/**
 * `/api/v1` code-extension control-plane routes.
 *
 * Resumes the addressed Session for catalog reads and reloads, and borrows
 * the main Agent only for command activation. Callback-bearing extension
 * contributions remain inside the engine scopes.
 */

import {
  IAgentExtensionService,
  ISessionExtensionService,
  ISessionLifecycleService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { okEnvelope, errEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  activateExtensionCommandRequestSchema,
  activateExtensionCommandResponseSchema,
  extensionSessionParamsSchema,
  listExtensionCommandsResponseSchema,
  reloadExtensionsResponseSchema,
} from '../protocol/rest-extension';
import { ensureMainAgent } from '../transport/mainAgent';

interface ExtensionRouteHost {
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

export function registerExtensionRoutes(app: ExtensionRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/extensions/commands',
      params: extensionSessionParamsSchema,
      success: { data: listExtensionCommandsResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List slash commands contributed by code extensions',
      tags: ['extensions'],
      operationId: 'listExtensionCommands',
    },
    async (req, reply) => {
      const extensions = await resolveExtensions(core, req.params.session_id);
      if (extensions === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      const commands = await extensions.listCommands();
      reply.send(
        okEnvelope(
          {
            commands: commands.map((command) => ({
              extension_id: command.extensionId,
              name: command.name,
              description: command.description,
            })),
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<ExtensionRouteHost['get']>[2],
  );

  const reloadRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/extensions/reload',
      params: extensionSessionParamsSchema,
      success: { data: reloadExtensionsResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'Reload code extensions for a session workspace',
      tags: ['extensions'],
      operationId: 'reloadExtensions',
    },
    async (req, reply) => {
      const extensions = await resolveExtensions(core, req.params.session_id);
      if (extensions === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      reply.send(okEnvelope(await extensions.reload(), req.id));
    },
  );
  app.post(
    reloadRoute.path,
    reloadRoute.options,
    reloadRoute.handler as Parameters<ExtensionRouteHost['post']>[2],
  );

  const activateRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/extensions/commands/activate',
      params: extensionSessionParamsSchema,
      body: activateExtensionCommandRequestSchema,
      success: { data: activateExtensionCommandResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'Activate a code-extension command on the main Agent',
      tags: ['extensions'],
      operationId: 'activateExtensionCommand',
    },
    async (req, reply) => {
      const session = await core.accessor
        .get(ISessionLifecycleService)
        .resume(req.params.session_id);
      if (session === undefined) {
        reply.send(sessionNotFound(req.params.session_id, req.id));
        return;
      }
      const main = await ensureMainAgent(session);
      const activated = await main.accessor.get(IAgentExtensionService).activateCommand({
        extensionId: req.body.extension_id,
        name: req.body.name,
        args: req.body.args,
      });
      reply.send(okEnvelope({ activated }, req.id));
    },
  );
  app.post(
    activateRoute.path,
    activateRoute.options,
    activateRoute.handler as Parameters<ExtensionRouteHost['post']>[2],
  );
}

async function resolveExtensions(
  core: Scope,
  sessionId: string,
): Promise<ISessionExtensionService | undefined> {
  const session = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
  return session?.accessor.get(ISessionExtensionService);
}

function sessionNotFound(sessionId: string, requestId: string) {
  return errEnvelope(
    ErrorCode.SESSION_NOT_FOUND,
    `session ${sessionId} does not exist`,
    requestId,
  );
}
