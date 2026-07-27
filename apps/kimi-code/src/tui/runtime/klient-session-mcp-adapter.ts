import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionMcpPort } from './session-mcp-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientAgentFacade = ReturnType<KlientSessionFacade['agent']>;

interface KlientMcpAgentFacade {
  readonly mcp: {
    list(): ReturnType<KlientAgentFacade['mcp']['list']>;
    reconnect(
      name: Parameters<KlientAgentFacade['mcp']['reconnect']>[0],
    ): ReturnType<KlientAgentFacade['mcp']['reconnect']>;
    initialLoadDurationMs(): ReturnType<
      KlientAgentFacade['mcp']['initialLoadDurationMs']
    >;
  };
}

interface KlientMcpSessionFacade {
  agent(agentId: string): KlientMcpAgentFacade;
}

/** Bind one Klient session agent to the runtime-neutral MCP port. */
export function createKlientSessionMcpPort(
  session: KlientMcpSessionFacade,
  agentId: string,
): SessionMcpPort {
  const agent = session.agent(agentId);
  return {
    list: async () =>
      (await agent.mcp.list()).map((server) => ({
        name: server.name,
        transport: server.transport,
        status: server.status,
        toolCount: server.toolCount,
        error: server.error,
      })),
    reconnect: async (name) => {
      await agent.mcp.reconnect(name);
    },
    initialLoadDurationMs: () => agent.mcp.initialLoadDurationMs(),
  };
}
