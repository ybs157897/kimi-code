import {
  copyTUIContextMessage,
  type SessionContextView,
  type SessionContextViewPort,
} from './session-context-view-port';

interface KlientContextViewAgentFacade {
  getContext(): Promise<SessionContextView>;
}

interface KlientContextViewSessionFacade {
  agent(agentId: string): KlientContextViewAgentFacade;
}

/** Bind one Klient session agent to the read-only context view. */
export function createKlientSessionContextViewPort(
  session: KlientContextViewSessionFacade,
  agentId: string,
): SessionContextViewPort {
  const agent = session.agent(agentId);
  return {
    read: async () => {
      const context = await agent.getContext();
      return {
        history: context.history.map(copyTUIContextMessage),
        tokenCount: context.tokenCount,
      };
    },
  };
}
