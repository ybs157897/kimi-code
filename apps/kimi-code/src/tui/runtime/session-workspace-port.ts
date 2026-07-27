/**
 * Runtime-neutral workspace boundary for one active session.
 *
 * Adapters expose only the workspace state and mutation needed by the TUI.
 */

export interface SessionWorkspaceSnapshot {
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
}

export interface SessionWorkspaceAddOptions {
  readonly persist?: boolean;
}

export interface SessionWorkspaceAdditionalDirsResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly persisted: boolean;
}

export interface SessionWorkspacePort {
  get(): Promise<SessionWorkspaceSnapshot>;
  addAdditionalDir(
    path: string,
    options?: SessionWorkspaceAddOptions,
  ): Promise<SessionWorkspaceAdditionalDirsResult>;
}
