/**
 * Native `/api/v2` route registration.
 *
 * New v2-only product capabilities live here so the compatibility `/api/v1`
 * contract remains stable.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';

import { registerExpertTeamsV2Routes } from './expertTeamsV2';

interface ApiV2AppHost {
  register(
    plugin: (apiV2: unknown) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

export async function registerApiV2Routes(app: ApiV2AppHost, core: Scope): Promise<void> {
  await app.register(
    async (apiV2) => {
      registerExpertTeamsV2Routes(
        apiV2 as Parameters<typeof registerExpertTeamsV2Routes>[0],
        core,
      );
    },
    { prefix: '/api/v2' },
  );
}
