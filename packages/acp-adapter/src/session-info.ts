import type { SessionInfo } from '@agentclientprotocol/sdk';

import type { AcpSessionSummary } from './types';

/**
 * Project a Kimi SDK {@link SessionSummary} into the ACP
 * {@link SessionInfo} shape used by `session/list`.
 *
 * Field mapping (mirrors the Python reference at
 * `acp/server.py:303-322`):
 *  - `sessionId` ← `summary.id`.
 *  - `cwd`        ← `summary.workDir` (the SDK's name for the same
 *                    concept; ACP picked `cwd` and the rename happens
 *                    at every boundary in this adapter).
 *  - `title`      ← `summary.title` when present; otherwise omitted
 *                    (ACP's `title` is `string | null | undefined`).
 *                    Empty strings are normalized to `null` so the
 *                    client can detect "no title" via `=== null`
 *                    rather than chasing falsy semantics.
 *  - `updatedAt`  ← `new Date(summary.updatedAt).toISOString()`. The
 *                    SDK stores epoch ms (`number`); ACP wants ISO 8601.
 *                    Invalid timestamps fall back to `null` rather
 *                    than producing `Invalid Date` strings on the wire.
 */
export function sessionSummaryToSessionInfo(summary: AcpSessionSummary): SessionInfo {
  return {
    sessionId: summary.id,
    cwd: summary.workDir,
    title: summary.title,
    updatedAt: summary.updatedAt,
  };
}
