import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionContextControlPort } from './session-context-control-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientAgentFacade = ReturnType<KlientSessionFacade['agent']>;

interface KlientContextControlAgentFacade {
  compact(
    input?: Parameters<KlientAgentFacade['compact']>[0],
  ): ReturnType<KlientAgentFacade['compact']>;
  cancelCompaction(): ReturnType<KlientAgentFacade['cancelCompaction']>;
  undoHistory(
    count?: Parameters<KlientAgentFacade['undoHistory']>[0],
  ): ReturnType<KlientAgentFacade['undoHistory']>;
}

interface KlientContextControlSessionFacade {
  agent(agentId: string): KlientContextControlAgentFacade;
}

/** Bind one Klient session agent to the TUI context-control port. */
export function createKlientSessionContextControlPort(
  session: KlientContextControlSessionFacade,
  agentId: string,
): SessionContextControlPort {
  const agent = session.agent(agentId);
  return {
    compact: (input) => agent.compact(input),
    cancelCompaction: async () => {
      await agent.cancelCompaction();
    },
    undoHistory: async (count) => {
      await agent.undoHistory(count);
    },
  };
}
