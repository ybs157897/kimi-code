/**
 * `POST /sessions` — create a new session.
 */

import {
  IEventService,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import { createSessionRequestSchema } from '../../protocol/rest-session';
import { sessionSchema } from '../../protocol/session';

import { errEnvelope, okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import { buildValidationEnvelope, sendMappedError } from './errors';
import { detailsSchema } from './schemas';
import type { SessionRouteHost } from './types';
import { toWireSession } from './wire';

export function registerCreateRoute(app: SessionRouteHost, core: Scope): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
      const workspaceId = body.workspace_id;
      if (workspaceId === undefined && callerCwd === undefined) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'metadata.cwd', message: 'either workspace_id or metadata.cwd is required' }],
            req.id,
          ),
        );
        return;
      }

      const registry = core.accessor.get(IWorkspaceService);
      let workDir: string;
      if (workspaceId !== undefined) {
        const workspace = await registry.get(workspaceId);
        if (workspace === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (callerCwd !== undefined && callerCwd !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: 'metadata.cwd',
                  message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
      } else {
        workDir = callerCwd as string;
      }

      // Ensure the workspace is registered so `metadata.cwd` is resolvable on
      // read (gap G3 — v2 does not store workDir on the session).
      try {
        const touched = await registry.createOrTouch(workDir);

        const handle = await core.accessor.get(ISessionLifecycleService).create({
          workDir,
          title: body.title,
          metadata: customMetadataFromWire(body.metadata),
        });
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const session = toWireSession(
          { ...meta, workspaceId: touched.id },
          touched.root,
          { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
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
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );
}

function customMetadataFromWire(
  metadata: { cwd: string; [key: string]: unknown } | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const { cwd: _drop, ...custom } = metadata;
  return Object.keys(custom).length === 0 ? undefined : custom;
}
