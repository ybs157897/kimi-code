/** Runtime-neutral shell details recorded in a diagnostic archive manifest. */
export interface RuntimeSessionExportShellEnvironment {
  readonly term?: string;
  readonly termProgram?: string;
  readonly termProgramVersion?: string;
  readonly multiplexer?: string;
  readonly shell?: string;
}

/** Process-level input used to export one session's diagnostic archive. */
export interface RuntimeSessionExportInput {
  readonly sessionId: string;
  readonly version: string;
  readonly installSource?: string;
  readonly shellEnv?: RuntimeSessionExportShellEnvironment;
  readonly includeGlobalLog?: boolean;
  readonly outputPath?: string;
}

/** Wire-friendly metadata written into a session diagnostic archive. */
export interface RuntimeSessionExportManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string;
  readonly sessionLastActivity?: string;
  readonly title?: string;
  readonly workspaceDir?: string;
  readonly sessionLogPath?: string;
  readonly globalLogPath?: string;
  readonly desktopLogPath?: string;
  readonly webLogPath?: string;
  readonly installSource?: string;
  readonly shellEnv?: RuntimeSessionExportShellEnvironment;
}

export interface RuntimeSessionExportResult {
  readonly zipPath: string;
  readonly manifest: RuntimeSessionExportManifest;
  readonly entries: readonly string[];
}

/** App-scope session diagnostic export capability used by the TUI. */
export interface RuntimeSessionExportPort {
  export(input: RuntimeSessionExportInput): Promise<RuntimeSessionExportResult>;
}

export function copyRuntimeSessionExportResult(
  result: RuntimeSessionExportResult,
): RuntimeSessionExportResult {
  return {
    zipPath: result.zipPath,
    manifest: {
      sessionId: result.manifest.sessionId,
      exportedAt: result.manifest.exportedAt,
      kimiCodeVersion: result.manifest.kimiCodeVersion,
      wireProtocolVersion: result.manifest.wireProtocolVersion,
      os: result.manifest.os,
      nodejsVersion: result.manifest.nodejsVersion,
      sessionFirstActivity: result.manifest.sessionFirstActivity,
      sessionLastActivity: result.manifest.sessionLastActivity,
      title: result.manifest.title,
      workspaceDir: result.manifest.workspaceDir,
      sessionLogPath: result.manifest.sessionLogPath,
      globalLogPath: result.manifest.globalLogPath,
      desktopLogPath: result.manifest.desktopLogPath,
      webLogPath: result.manifest.webLogPath,
      installSource: result.manifest.installSource,
      shellEnv:
        result.manifest.shellEnv === undefined
          ? undefined
          : {
              term: result.manifest.shellEnv.term,
              termProgram: result.manifest.shellEnv.termProgram,
              termProgramVersion: result.manifest.shellEnv.termProgramVersion,
              multiplexer: result.manifest.shellEnv.multiplexer,
              shell: result.manifest.shellEnv.shell,
            },
    },
    entries: [...result.entries],
  };
}
