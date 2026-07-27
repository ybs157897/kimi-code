import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  copyRuntimeSessionExportResult,
  type RuntimeSessionExportPort,
} from './runtime-session-export-port';

interface LegacyRuntimeSessionExportHarness {
  readonly exportSession: KimiHarness['exportSession'];
}

/** Bridge the legacy SDK session exporter into the neutral TUI port. */
export function createLegacyRuntimeSessionExportPort(
  harness: LegacyRuntimeSessionExportHarness,
): RuntimeSessionExportPort {
  return {
    export: async (input) => {
      const result = await harness.exportSession({
        id: input.sessionId,
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
