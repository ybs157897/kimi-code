import { type Event } from '@moonshot-ai/kimi-code-sdk';

/**
 * Telemetry sink threaded into {@link AcpSession} so reverse-RPC bridges
 * (`handleApproval`, `handleQuestion`) can emit PII-free breadcrumbs
 * without reaching back through the harness. Optional — when absent,
 * the session is a silent passthrough (matches the Phase 11.2 stub-
 * tolerant pattern in `server.ts:trackSessionStarted`).
 */
export type TelemetryTrackFn = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

/**
 * Map a Kimi SDK error (raw `Error`, `KimiError`, or `KimiErrorPayload`)
 * into the ACP {@link RequestError} shape used by the JSON-RPC layer.
 *
 * Auth-coded inputs (`auth.login_required`, `provider.auth_error`)
 * become `RequestError.authRequired()` so the client can drive its own
 * re-auth UX. Everything else becomes `RequestError.internalError(...)`
 * with the raw error logged to the agent log file but NOT exposed in
 * the JSON-RPC response — the client only sees the canonical
 * "session prompt failed" message, preventing accidental leakage of
 * stack frames or PII through the wire.
 *
 * The kimi-cli Python reference performs the same mapping at
 * `kimi-cli/src/kimi_cli/acp/session.py:218-247`; this is the TS port.
 */
export type CompactionCompletedResult = Extract<Event, { type: 'compaction.completed' }>['result'];

export type CompactionOutcome =
  | { readonly kind: 'completed'; readonly result: CompactionCompletedResult }
  | { readonly kind: 'cancelled' };

/**
 * Identifier the agent-core session emits for the main (user-facing)
 * agent. Subagents are issued generated ids by `Session.spawnAgent`;
 * filtering on this constant keeps `turn.ended` / `error` events from a
 * child agent from settling the parent's `session/prompt` promise.
 */
export const MAIN_AGENT_ID = 'main';
