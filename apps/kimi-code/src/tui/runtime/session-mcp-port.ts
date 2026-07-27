/**
 * Runtime-neutral MCP control plane for one active session and agent.
 *
 * Adapters project runtime-owned server entries into this local view and
 * expose only the read/reconnect operations used by the interactive TUI.
 */

export interface McpServerView {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export interface SessionMcpPort {
  list(): Promise<readonly McpServerView[]>;
  reconnect(name: string): Promise<void>;
  initialLoadDurationMs(): Promise<number>;
}
