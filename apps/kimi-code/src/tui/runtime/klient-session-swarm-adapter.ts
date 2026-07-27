import type {
  SessionSwarmPort,
  SessionSwarmTrigger,
} from './session-swarm-port';

interface KlientSwarmAgentFacade {
  readonly swarm: {
    isActive(): Promise<boolean>;
    enter(trigger: SessionSwarmTrigger): Promise<void>;
    exit(): Promise<void>;
  };
}

interface KlientSwarmSessionFacade {
  agent(agentId: string): KlientSwarmAgentFacade;
}

interface KlientSwarmFacade {
  session(sessionId: string): KlientSwarmSessionFacade;
}

interface KlientSwarmRuntime {
  readonly klient: KlientSwarmFacade;
}

/** Bind one Klient session and agent to the runtime-neutral swarm port. */
export function createKlientSessionSwarmPort(
  runtime: KlientSwarmRuntime | KlientSwarmFacade,
  sessionId: string,
  agentId: string,
): SessionSwarmPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;
  const swarm = klient.session(sessionId).agent(agentId).swarm;

  return {
    isActive: () => swarm.isActive(),
    enter: async (trigger) => {
      await swarm.enter(trigger);
    },
    exit: async () => {
      await swarm.exit();
    },
  };
}
