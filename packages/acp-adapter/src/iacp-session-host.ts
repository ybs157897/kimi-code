/**
 * Minimal interface that the ACP adapter's `AcpSession` requires from "a session".
 *
 * Both the legacy SDK `Session` and the v2 `KlientSessionAdapter` satisfy this
 * contract, allowing `AcpSession` to work with either engine backend without
 * internal changes.
 *
 * The union return types (`any` for complex shapes) keep the adapter free of
 * engine-specific type imports — the consuming functions (`formatStatusReport`
 * etc. in `session.ts`) only access properties that both engines provide.
 */

import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/kimi-code-sdk';

type Unsubscribe = () => void;

export interface IAcpSessionHost {
  readonly id: string;

  /**
   * Optional resume state for replay.
   * May return the state synchronously or as a Promise.
   */
  getResumeState?(): unknown | Promise<unknown>;

  /** Per-session metadata summary (includes `sessionDir`). */
  readonly summary?: { readonly sessionDir?: string };

  // ── Lifecycle ──────────────────────────────────────────────────────

  prompt(input: unknown): Promise<unknown>;
  activateSkill(name: string, args?: string): Promise<unknown>;
  cancel(): Promise<void>;
  compact(options?: { instruction?: string }): Promise<unknown>;

  // ── Model / Permission ──────────────────────────────────────────────

  setModel(modelId: string): Promise<unknown>;
  setThinking?(effort: string): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  setPermission(mode: string): Promise<void>;

  // ── Status / Usage ─────────────────────────────────────────────────

  getStatus(): Promise<any>;
  getUsage(): Promise<any>;

  // ── MCP / Tasks / Skills ──────────────────────────────────────────

  listMcpServers(): Promise<readonly any[]>;
  listBackgroundTasks(): Promise<readonly any[]>;
  listSkills(): Promise<readonly any[]>;

  // ── Events ─────────────────────────────────────────────────────────

  onEvent(listener: (event: any) => void): Unsubscribe;

  // ── Approval / Question reverse-RPC ────────────────────────────────

  setApprovalHandler(handler: ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) | undefined): void;
  setQuestionHandler(handler: ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>) | undefined): void;
}
