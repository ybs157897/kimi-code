import type {
  SessionWarningSeverity,
  SessionWarningsPort,
} from './session-warnings-port';

interface KlientSessionWarning {
  readonly code: string;
  readonly message: string;
  readonly severity?: SessionWarningSeverity;
}

interface KlientSessionWarningsSession {
  readonly warnings: {
    list(): Promise<readonly KlientSessionWarning[]>;
  };
}

/** Bridge one Klient session into the runtime-neutral warnings port. */
export function createKlientSessionWarningsPort(
  session: KlientSessionWarningsSession,
): SessionWarningsPort {
  return {
    list: async () =>
      (await session.warnings.list()).map((warning) => ({
        code: warning.code,
        message: warning.message,
        severity: warning.severity ?? 'warning',
      })),
  };
}
