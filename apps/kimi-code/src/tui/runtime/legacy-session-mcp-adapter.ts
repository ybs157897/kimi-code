import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionMcpPort } from './session-mcp-port';

interface LegacySessionMcpSession {
  listMcpServers(): ReturnType<Session['listMcpServers']>;
  reconnectMcpServer(
    name: Parameters<Session['reconnectMcpServer']>[0],
  ): ReturnType<Session['reconnectMcpServer']>;
  getMcpStartupMetrics(): ReturnType<Session['getMcpStartupMetrics']>;
}

/** Bridge one active legacy Session into the runtime-neutral MCP port. */
export function createLegacySessionMcpPort(
  session: LegacySessionMcpSession,
): SessionMcpPort {
  return {
    list: async () =>
      (await session.listMcpServers()).map((server) => ({
        name: server.name,
        transport: server.transport,
        status: server.status,
        toolCount: server.toolCount,
        error: server.error,
      })),
    reconnect: async (name) => {
      await session.reconnectMcpServer(name);
    },
    initialLoadDurationMs: async () => {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    },
  };
}
