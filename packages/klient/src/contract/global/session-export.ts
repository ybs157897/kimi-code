/**
 * `sessionExportService` — App-scope session diagnostic archive export.
 * Mirrors `agent-core-v2/app/sessionExport/sessionExport.ts`; only the
 * wire-safe payload is exposed, while process-local export options stay
 * inside the host.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const shellEnvironmentSchema = z.object({
  term: z.string().optional(),
  termProgram: z.string().optional(),
  termProgramVersion: z.string().optional(),
  multiplexer: z.string().optional(),
  shell: z.string().optional(),
});

export const exportSessionPayloadSchema = z.object({
  sessionId: z.string(),
  outputPath: z.string().optional(),
  includeGlobalLog: z.boolean().optional(),
  includeDesktopLog: z.boolean().optional(),
  version: z.string(),
  installSource: z.string().optional(),
  shellEnv: shellEnvironmentSchema.optional(),
});

export const exportSessionManifestSchema = z.object({
  sessionId: z.string(),
  exportedAt: z.string(),
  kimiCodeVersion: z.string(),
  wireProtocolVersion: z.string(),
  os: z.string(),
  nodejsVersion: z.string(),
  sessionFirstActivity: z.string().optional(),
  sessionLastActivity: z.string().optional(),
  title: z.string().optional(),
  workspaceDir: z.string().optional(),
  sessionLogPath: z.string().optional(),
  globalLogPath: z.string().optional(),
  desktopLogPath: z.string().optional(),
  webLogPath: z.string().optional(),
  installSource: z.string().optional(),
  shellEnv: shellEnvironmentSchema.optional(),
});

export const exportSessionResultSchema = z.object({
  zipPath: z.string(),
  entries: z.array(z.string()),
  sessionDir: z.string(),
  manifest: exportSessionManifestSchema,
});

export const sessionExportContract = {
  export: {
    input: z.tuple([exportSessionPayloadSchema]),
    output: exportSessionResultSchema,
  },
} satisfies ServiceContract;
