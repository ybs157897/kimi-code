// apps/kimi-web/src/api/daemon/wireWsSync.ts
// Daemon wire DTOs — v2 sync protocol: cursors + session snapshot. Part of the
// shared wire barrel (wire.ts); ALL fields stay snake_case as they appear on
// the wire.

import type { WireApprovalRequest } from './wireApproval';
import type { WireMessage } from './wireMessage';
import type { WireQuestionRequest } from './wireQuestion';
import type { WireSession } from './wireSession';
import type { WireTask } from './wireTask';

// ---------------------------------------------------------------------------
// v2 sync protocol: cursors + session snapshot
// ---------------------------------------------------------------------------

/** Per-session sync cursor: durable seq + journal epoch. */
export interface WireSessionCursor {
  seq: number;
  epoch?: string;
}

export interface WireInFlightToolCall {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  last_progress?: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

export interface WireInFlightTurn {
  turn_id: number;
  assistant_text: string;
  thinking_text: string;
  running_tools: WireInFlightToolCall[];
  current_prompt_id?: string;
}

/** `GET /sessions/{sid}/snapshot` — atomic rebuild state at a watermark. */
export interface WireSessionSnapshot {
  as_of_seq: number;
  epoch: string;
  session: WireSession;
  messages: { items: WireMessage[]; has_more: boolean };
  in_flight_turn: WireInFlightTurn | null;
  /** Live subagent roster at the watermark (absent on older servers). */
  subagents?: WireTask[];
  pending_approvals: WireApprovalRequest[];
  pending_questions: WireQuestionRequest[];
}

export interface WireSessionAbortResult {
  aborted: boolean;
}
