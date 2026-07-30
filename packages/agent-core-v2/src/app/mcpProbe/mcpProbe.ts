/**
 * `mcpProbe` domain (L5) — App-scoped MCP server connectivity probe contract.
 *
 * Defines `IMcpProbeService` for one-shot MCP server connectivity testing.
 * Creates a temporary connection, lists tools, and immediately shuts down —
 * success and failure both clean up. Bound at App scope.
 */

import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface McpProbeResult {
  readonly serverName: string;
  readonly success: boolean;
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpProbeOptions {
  readonly cwd?: string;
}

export interface IMcpProbeService {
  readonly _serviceBrand: undefined;

  /** Test connectivity to a single MCP server. Always cleans up. */
  probe(
    serverName: string,
    config: McpServerConfig,
    options?: McpProbeOptions,
  ): Promise<McpProbeResult>;
}

export const IMcpProbeService: ServiceIdentifier<IMcpProbeService> =
  createDecorator<IMcpProbeService>('mcpProbeService');
