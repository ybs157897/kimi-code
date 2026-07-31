/**
 * `POST /sessions/{tail}` — the session action dispatch route
 * (fork / compact / undo / abort / btw / archive / restore), plus the
 * action-only helpers (main-agent resolution, undo message paging).
 */

import {
  Error2,
  ErrorCodes,
  IAgentContextMemoryService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentRPCService,
  IAuthSummaryService,
  IEventService,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionLegacyService,
  ISessionLifecycleService,
  ISessionMetadata,
  toProtocolMessage,
  type ContextMessage,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../../protocol/error-codes';
import {
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  forkSessionRequestSchema,
  sessionAbortResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
} from '../../protocol/rest-session';
import { sessionSchema } from '../../protocol/session';
import { z } from 'zod';

import { okEnvelope } from '../../envelope';
import { requestLog } from '../../lib/requestLog';
import { defineRoute } from '../../middleware/defineRoute';
import { ensureMainAgent } from '../../transport/mainAgent';
import { parseActionSuffix } from '../action-suffix';
import { buildValidationEnvelope, sendMappedError } from './errors';
import { detailsSchema, sessionActionRequestSchema, sessionActionTailParamSchema } from './schemas';
import type { SessionRouteHost } from './types';
import { resolveSessionFacts, toWireSession } from './wire';

export function registerActionRoute(app: SessionRouteHost, core: Scope): void {
  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionAbortResponseSchema,
          startBtwSessionResponseSchema,
          archiveSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'archive', 'restore'] as const,
          resourceLabel: 'session',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          return;
        }

        const legacy = core.accessor.get(ISessionLegacyService);

        if (parsed.action === 'fork') {
          const body = forkSessionRequestSchema.parse(req.body);
          // `lifecycle.fork` throws `session.not_found` for an unknown source,
          // so no explicit existence check is needed here.
          const handle = await core.accessor.get(ISessionLifecycleService).fork({
            sourceSessionId: parsed.id,
            title: body.title,
            metadata: body.metadata,
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
          requestLog(req)?.info(
            { session_id: parsed.id, action: 'fork', new_session_id: session.id },
            'session action completed',
          );
          reply.send(okEnvelope(session, req.id));
          return;
        }

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          const agent = await resolveMainAgent(core, parsed.id);
          // `begin` returns false when busy / over the per-turn limit — v1
          // treats that as a silent success. It throws `compaction.unable`
          // when there is no compactable prefix, which propagates.
          agent.accessor
            .get(IAgentFullCompactionService)
            .begin({ source: 'manual', instruction: normalizeOptional(body.instruction) });
          requestLog(req)?.info({ session_id: parsed.id, action: 'compact' }, 'session action completed');
          reply.send(okEnvelope({}, req.id));
          return;
        }

        if (parsed.action === 'undo') {
          const body = undoSessionRequestSchema.parse(req.body);
          const agent = await resolveMainAgent(core, parsed.id);
          // The conversation undo service throws `session.undo_unavailable` (with a
          // structured `reason`) when fewer than `count` turns may be cut;
          // it quiesces the loop/compaction first, so the post-undo read
          // below always sees the cut applied.
          await agent.accessor.get(IAgentConversationUndoService).undo(body.count);
          const history = agent.accessor.get(IAgentContextMemoryService).get();
          requestLog(req)?.info({ session_id: parsed.id, action: 'undo' }, 'session action completed');
          const [summary, status] = await Promise.all([
            core.accessor.get(ISessionIndex).get(parsed.id),
            legacy.status(parsed.id),
          ]);
          reply.send(
            okEnvelope(
              {
                messages: pageUndoMessages(
                  parsed.id,
                  summary?.createdAt ?? 0,
                  history,
                  body.page_size,
                ),
                status,
              },
              req.id,
            ),
          );
          return;
        }

        if (parsed.action === 'abort') {
          const agent = await resolveMainAgent(core, parsed.id);
          // No turnId → cancel whatever turn is active; a safe no-op when idle.
          // v1 always reports success once the session exists.
          await agent.accessor.get(IAgentRPCService).cancel({});
          requestLog(req)?.info({ session_id: parsed.id, action: 'abort' }, 'session action completed');
          reply.send(okEnvelope({ aborted: true }, req.id));
          return;
        }

        if (parsed.action === 'btw') {
          // `resume` (not `get`) so a freshly-opened cold session can start a
          // side-channel agent; matches v1's `startBtw` which resumes first.
          const session = await core.accessor.get(ISessionLifecycleService).resume(parsed.id);
          if (session === undefined) {
            throw new Error2(
              ErrorCodes.SESSION_NOT_FOUND,
              `session ${parsed.id} does not exist`,
            );
          }
          await core.accessor.get(IAuthSummaryService).ensureReady();
          const agentId = await session.accessor.get(ISessionBtwService).start();
          reply.send(okEnvelope({ agent_id: agentId }, req.id));
          return;
        }

        if (parsed.action === 'restore') {
          const restored = await core.accessor.get(ISessionLifecycleService).restore(parsed.id);
          if (restored === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
          }
          const meta = await restored.accessor.get(ISessionMetadata).read();
          const ctx = restored.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          requestLog(req)?.info({ session_id: parsed.id, action: 'restore' }, 'session action completed');
          reply.send(okEnvelope(session, req.id));
          return;
        }

        // archive — `resume` (not `get`) so archiving a freshly-opened cold
        // session still works; `resume` returns undefined only when the session
        // is unknown or its workspace is gone, reported as `session.not_found`.
        const archived = await core.accessor.get(ISessionLifecycleService).resume(parsed.id);
        if (archived === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
        }
        await core.accessor.get(ISessionLifecycleService).archive(parsed.id);
        requestLog(req)?.info({ session_id: parsed.id, action: 'archive' }, 'session action completed');
        reply.send(okEnvelope({ archived: true }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );
}

/**
 * Resume the session (cold-load if needed) and resolve its main agent, throwing
 * `session.not_found` when the session is unknown or its workspace is gone.
 * Shared by the `compact` / `abort` actions, which both operate on the main
 * agent but carry no v1-specific projection worth keeping in
 * `ISessionLegacyService`.
 */
async function resolveMainAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

/** Trim a compaction instruction; treat an empty/blank value as absent. */
function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** v1 `:undo` message page-size clamp (`packages/agent-core/.../sessionService.ts`). */
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

/**
 * Mirror of v1 `pageContextMessages`: project the post-undo history into a
 * newest-first wire page, clamping `page_size` to `[1, 100]` (default 50).
 */
function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly ContextMessage[],
  requestedPageSize: number | undefined,
): { items: ReturnType<typeof toProtocolMessage>[]; has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}
