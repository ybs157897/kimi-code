/**
 * Wire projection for the `/sessions` routes: maps service return values to
 * the v1 wire `Session` shape and resolves the live session facts projected
 * onto it.
 */

import {
  ISessionActivityView,
  ISessionLifecycleService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  emptySessionUsage,
  type Session,
  type SessionPendingInteraction,
} from '../../protocol/session';

// ---------------------------------------------------------------------------
// API body wrapper — pure field projection from a service return value to the
// wire `Session` shape. No service calls, no control flow: handlers pull data
// through `ServiceAccessor.get` and pass it straight here.
// ---------------------------------------------------------------------------

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
): Session {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    busy: facts.busy,
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason: facts.lastTurnReason,
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    agent_config: { model: '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

/** Live activity and interaction facts projected onto the wire `Session`. */
export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

/**
 * Resolve a session's live wire facts from the core `ISessionActivityView`
 * aggregate (`busy` = any agent with an active turn or background task; the
 * reason is the main agent's latest turn outcome, `blocked` folds into
 * `failed`). A cold session (no live handle) is not busy and carries no
 * outcome.
 */
export function resolveSessionFacts(core: Scope, sessionId: string): SessionFacts {
  const handle = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (handle === undefined) {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
    };
  }
  return handle.accessor.get(ISessionActivityView).state();
}

/**
 * Build the wire `Session.metadata`: caller-supplied custom fields (minus the
 * reserved `goal` key, matching v1's `toProtocolSession`) overlaid with the
 * required `cwd`. `cwd` always wins so the resolved work dir is authoritative.
 */
function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
  cwd: string,
): { cwd: string; [key: string]: unknown } {
  if (custom === undefined) return { cwd };
  const { goal: _drop, ...rest } = custom as { goal?: unknown; [key: string]: unknown };
  return { ...rest, cwd };
}
