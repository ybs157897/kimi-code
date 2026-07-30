import type {
  AgentSideConnection,
  ClientCapabilities,
  PromptResponse,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';

import type { IAcpSessionHost } from './iacp-session-host';
import type { McpServerConfig } from './mcp';

/** Engine-neutral model row consumed by ACP config-option rendering. */
export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly thinkingSupported: boolean;
  readonly alwaysThinking?: boolean;
  readonly supportEfforts: readonly string[];
  readonly defaultThinkingEffort: string;
}

/** Optional host image limit used by the ACP prompt media boundary. */
export interface AcpImageLimits {
  readonly maxEdgePx?: number;
}

/** Parameters needed to create one ACP-backed engine session. */
export interface AcpCreateSessionParams {
  readonly sessionId: string;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly mode?: 'new';
}

/** Parameters needed to attach to one persisted ACP-backed engine session. */
export interface AcpResumeSessionParams {
  readonly sessionId: string;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly mode?: 'load' | 'resume';
}

/** Optional filters for the ACP session-list surface. */
export interface AcpListSessionsParams {
  readonly workDir?: string;
  readonly sessionId?: string;
}

/** Runtime-neutral session summary projected into ACP `SessionInfo`. */
export interface AcpSessionSummary {
  readonly id: string;
  readonly workDir: string;
  readonly title: string | null;
  readonly updatedAt: string | null;
}

/** The protocol layer only needs the narrow session host contract. */
export type AcpSessionHost = IAcpSessionHost;

/** Minimal event envelope accepted by engine-neutral ACP test hosts. */
export interface AcpProtocolEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Runtime-neutral process host used by the ACP protocol server.
 *
 * Host-only capabilities such as an editor-backed workspace filesystem stay
 * behind create/resume and never enter a wire contract.
 */
export interface AcpHost {
  readonly imageLimits?: AcpImageLimits;
  bindConnection?(connection: AgentSideConnection): void;
  setClientCapabilities?(capabilities: ClientCapabilities | undefined): void;
  checkAuthenticated(): Promise<boolean>;
  createSession(params: AcpCreateSessionParams): Promise<AcpSessionHost>;
  resumeSession(params: AcpResumeSessionParams): Promise<AcpSessionHost>;
  listSessions(params?: AcpListSessionsParams): Promise<readonly AcpSessionSummary[]>;
  listAvailableModels(): Promise<readonly AcpModelEntry[]>;
  getDefaultModelId?(): Promise<string | undefined>;
  getDefaultThinkingEffort?(): Promise<string | undefined>;
  track?(event: string, properties?: Record<string, unknown>): void;
  close?(): Promise<void>;
}

/**
 * Local alias for the ACP `stopReason` enum.
 *
 * Surfaced separately so internal helpers (e.g. `turnEndReasonToStopReason`)
 * don't have to repeat the literal union and the file is the single place
 * to look when the upstream SDK widens or renames a variant.
 */
export type AcpStopReason = PromptResponse['stopReason'];

/**
 * Local alias for the ACP `ToolCallStatus` enum.
 *
 * Same rationale as {@link AcpStopReason}: keep SDK-coupled enum
 * names confined to this file so the rest of the adapter only sees
 * project-local types.
 */
export type AcpToolCallStatus = ToolCallStatus;

/**
 * Local alias for the ACP `ToolKind` enum.
 *
 * The kind is heuristic-mapped from Kimi tool names by
 * `events-map.inferToolKind`; aliasing here keeps the consumer side
 * (UI integration / future tool registries) decoupled from the raw
 * SDK type name.
 */
export type AcpToolKind = ToolKind;
