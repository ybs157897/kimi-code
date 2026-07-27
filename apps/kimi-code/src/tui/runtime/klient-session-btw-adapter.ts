import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionBtwPort } from './session-btw-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;

interface KlientSessionBtwFacade {
  readonly btw: {
    start(): ReturnType<KlientSessionFacade['btw']['start']>;
  };
}

/** Bridge one Klient session facade into the runtime-neutral BTW port. */
export function createKlientSessionBtwPort(
  session: KlientSessionBtwFacade,
): SessionBtwPort {
  return {
    start: async () => {
      const agentId = await session.btw.start();
      return agentId;
    },
  };
}
