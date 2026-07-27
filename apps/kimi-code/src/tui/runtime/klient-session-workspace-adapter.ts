import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { SessionWorkspacePort } from './session-workspace-port';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;

interface KlientSessionWorkspaceFacade {
  readonly workspace: {
    get(): ReturnType<KlientSessionFacade['workspace']['get']>;
    addAdditionalDir(
      input: Parameters<KlientSessionFacade['workspace']['addAdditionalDir']>[0],
    ): ReturnType<KlientSessionFacade['workspace']['addAdditionalDir']>;
  };
}

/** Bridge one Klient session facade into the runtime-neutral workspace port. */
export function createKlientSessionWorkspacePort(
  session: KlientSessionWorkspaceFacade,
): SessionWorkspacePort {
  return {
    get: async () => {
      const workspace = await session.workspace.get();
      return {
        workDir: workspace.workDir,
        additionalDirs: [...workspace.additionalDirs],
      };
    },
    addAdditionalDir: async (path, options) => {
      const result = await session.workspace.addAdditionalDir({
        path,
        persist: options?.persist,
      });
      return {
        projectRoot: result.projectRoot,
        configPath: result.configPath,
        additionalDirs: [...result.additionalDirs],
        persisted: result.persisted,
      };
    },
  };
}
