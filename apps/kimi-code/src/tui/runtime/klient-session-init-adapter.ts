import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionInitPort } from './session-init-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;

interface KlientSessionInitFacade {
  readonly init: {
    generateAgentsMd(): ReturnType<
      KlientSessionFacade['init']['generateAgentsMd']
    >;
    cancel(): ReturnType<KlientSessionFacade['init']['cancel']>;
  };
}

/** Bridge one Klient session facade into the runtime-neutral init port. */
export function createKlientSessionInitPort(
  session: KlientSessionInitFacade,
): SessionInitPort {
  return {
    generateAgentsMd: () => session.init.generateAgentsMd(),
    cancel: () => session.init.cancel(),
  };
}
