/**
 * `/sessions` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions` wire contract on top of
 * `agent-core-v2` services:
 *   POST   /sessions                  create
 *   GET    /sessions                  list
 *   GET    /sessions/{session_id}     get
 *   GET    /sessions/{session_id}/profile
 *   POST   /sessions/{session_id}/profile      update title / metadata / agent_config
 *   POST   /sessions/{tail}                    action: fork / compact / undo /
 *                                              abort / btw / archive / restore
 *   GET    /sessions/{session_id}/children     list child sessions
 *   POST   /sessions/{session_id}/children     create child session (fork+tag)
 *   GET    /sessions/{session_id}/status       best-effort
 *   GET    /sessions/{session_id}/goal         current goal (null when none)
 *   GET    /sessions/{session_id}/warnings     session-level notices
 *
 * The `POST /sessions/{tail}` actions split into two groups. The thin
 * pass-throughs — `fork` / `compact` / `abort` / `archive` / `restore` — call
 * the native v2 services directly (`ISessionLifecycleService.fork` / `archive` / `restore`,
 * `IAgentFullCompactionService.begin`, `IAgentRPCService.cancel`); there is no
 * v1-only projection to centralize, so no adapter is involved. `undo` likewise
 * calls `IAgentConversationUndoService.undo` directly (it throws
 * `session.undo_unavailable` with a structured reason) and only borrows
 * `ISessionLegacyService.status` for the cross-domain status rollup. The
 * `/sessions/{id}/children` endpoints call `ISessionLifecycleService.createChild`
 * and `ISessionIndex.list({ childOf })` directly — the child markers and
 * parent-title default live in the lifecycle, and the child filter lives in the
 * index. Only `POST /sessions/{id}/profile` (`updateProfile`),
 * `GET /sessions/{id}/status`, and `GET /sessions/{id}/goal` go through
 * `ISessionLegacyService` (the `agent_config` patch, the status rollup, and the
 * current-goal read hold real cross-domain adaptation);
 * the route forwards each adapter result verbatim, mirroring v1's thin handler.
 * `create`, `fork`, and child creation publish `event.session.created` on the
 * core event bus, matching v1.
 *
 * `GET /sessions/{id}/warnings` surfaces session-level notices in the v1
 * `{ code, message, severity }` wire shape: the `agents-md-oversized` warning
 * (projected from the main agent's `IAgentProfileService.getAgentsMdWarning()`
 * — computed and cached when the agent binds a profile) and the
 * secondary-model early-validation warning (projected from the Session-scope
 * `ISessionSecondaryModelWarningService` — computed and cached when the main
 * agent is created). An unbound main agent or a valid/unset secondary model
 * yields an empty list, matching v1's "no warning" case.
 *
 * **Wire fidelity**: mirrors v1's `toProtocolSession`
 * (`packages/agent-core/src/services/session/session.ts`), which populates
 * only the index/metadata fields and returns placeholders for the heavy ones
 * (`agent_config:{model:''}`, `usage:zeros`, `permission_rules:[]`,
 * `message_count:0`, `last_seq:0`). v2 produces the same placeholder shape
 * from `ISessionIndex` (with `cwd` persisted on the session itself), and now
 * also surfaces `last_prompt` and the merged custom `metadata`.
 *
 * **Busy / last turn**: v1's `SessionService` overwrites the placeholder
 * `status` with the live value before projecting (`_patchSessionStatus`). v2
 * projects the orthogonal facts instead: `toWireSession` takes
 * `resolveSessionFacts` — `busy` from the session lifecycle's authoritative
 * drain registry and `last_turn_reason` from the main agent's activity view (a
 * cold session is not busy and carries no reason) — so both are real on every
 * session-producing endpoint here. `GET /sessions` and
 * `GET /sessions/{id}/children` filter their projected page by the `busy`
 * query param (post-page, matching v1 — `has_more` reflects the pre-filter
 * page), except `archived_only` lists filter busy before route pagination so
 * they can drain archived pages the same way v1 does.
 *
 * **cwd resolution (gap G3 closed)**: the session's frozen work dir is
 * persisted on its metadata document (`ISessionMetadata`) and surfaced on the
 * `ISessionIndex` summary, so `metadata.cwd` comes from the session itself —
 * not from `IWorkspaceService`. Sessions whose workspace was unregistered keep
 * their original cwd and stay listed / gettable (matching v1, which stores
 * `workDir` on the session). `IWorkspaceService` is consulted only as a
 * back-compat fallback for sessions written before `cwd` was persisted.
 *
 * The route registrations live in `./sessions/` — one module per endpoint
 * group — with the shared request schemas, wire projection, and error
 * envelopes beside them; this file keeps the public registration entry point
 * and re-exports the wire projection helpers other surfaces reuse.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';

import { registerActionRoute } from './sessions/actionRoute';
import { registerChildrenRoutes } from './sessions/childrenRoutes';
import { registerCreateRoute } from './sessions/createRoute';
import { registerGetRoute } from './sessions/getRoute';
import { registerGoalRoute } from './sessions/goalRoute';
import { registerListRoute } from './sessions/listRoute';
import { registerProfileRoutes } from './sessions/profileRoutes';
import { registerStatusRoute } from './sessions/statusRoute';
import type { SessionRouteHost } from './sessions/types';
import { registerWarningsRoute } from './sessions/warningsRoute';

export * from './sessions/wire';

export function registerSessionsRoutes(app: SessionRouteHost, core: Scope): void {
  registerCreateRoute(app, core);
  registerListRoute(app, core);
  registerGetRoute(app, core);
  registerProfileRoutes(app, core);
  registerActionRoute(app, core);
  registerChildrenRoutes(app, core);
  registerStatusRoute(app, core);
  registerGoalRoute(app, core);
  registerWarningsRoute(app, core);
}
