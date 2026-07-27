import type { Session } from '@moonshot-ai/kimi-code-sdk';

import type { SessionWorkspacePort } from './session-workspace-port';

type LegacySessionSummary = Pick<
  NonNullable<Session['summary']>,
  'additionalDirs'
>;

interface LegacySessionWorkspaceSession {
  readonly workDir: Session['workDir'];
  readonly summary?: LegacySessionSummary;
  addAdditionalDir(
    path: Parameters<Session['addAdditionalDir']>[0],
    options?: Parameters<Session['addAdditionalDir']>[1],
  ): ReturnType<Session['addAdditionalDir']>;
}

/** Bridge an active SDK Session into the runtime-neutral workspace port. */
export function createLegacySessionWorkspacePort(
  session: LegacySessionWorkspaceSession,
): SessionWorkspacePort {
  return {
    get: async () => ({
      workDir: session.workDir,
      additionalDirs: [...(session.summary?.additionalDirs ?? [])],
    }),
    addAdditionalDir: async (path, options) => {
      const result = await session.addAdditionalDir(
        path,
        options?.persist === undefined ? undefined : { persist: options.persist },
      );
      return {
        projectRoot: result.projectRoot,
        configPath: result.configPath,
        additionalDirs: [...result.additionalDirs],
        persisted: result.persisted,
      };
    },
  };
}
