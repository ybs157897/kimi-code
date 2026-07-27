import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import {
  copyRuntimeSessionExportResult,
  type RuntimeSessionExportPort,
} from './runtime-session-export-port';

type Klient = KimiV2Runtime['klient'];

/** Bridge the v2 Klient session exporter into the neutral TUI port. */
export function createKlientRuntimeSessionExportPort(
  runtime: KimiV2Runtime | Klient,
): RuntimeSessionExportPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;

  return {
    export: async (input) => {
      const result = await klient.global.sessionExport.export({
        sessionId: input.sessionId,
        version: input.version,
        installSource: input.installSource,
        shellEnv: input.shellEnv,
        includeGlobalLog: input.includeGlobalLog,
        outputPath: input.outputPath,
      });
      return copyRuntimeSessionExportResult(result);
    },
  };
}
