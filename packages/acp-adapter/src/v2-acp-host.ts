/**
 * V2 runtime adapter — implements the `AcpHost` contract using a
 * `KimiV2Runtime` + `Klient`.
 *
 * This adapter wraps:
 *  - `runtime.hostedSessions` for session create/resume (with workspace FS factory)
 *  - `klient.global.sessions.list()` for session listing
 *  - `klient.global.auth.status()` for authentication checks
 *  - `listModelsFromKlient` for model catalog
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { Klient } from '@moonshot-ai/klient';
import type {
  AcpHost,
  AcpSessionHost,
  AcpCreateSessionParams,
  AcpResumeSessionParams,
  AcpListSessionsParams,
  AcpSessionSummary,
} from './types';
import { AcpWorkspaceFileSystemFactory } from './acp-workspace-file-system-factory';
import { V2SessionAdapter } from './v2-session-adapter';
import { listModelsFromKlient } from './model-catalog-v2';

export class V2AcpHost implements AcpHost {
  private workspaceFsFactory: AcpWorkspaceFileSystemFactory | undefined;
  private readonly runtime: any;
  private readonly klient: Klient;

  constructor(runtime: any, klient: Klient) {
    this.runtime = runtime;
    this.klient = klient;
  }

  /** Called by AcpServer once the AgentSideConnection is available. */
  setConnection(conn: AgentSideConnection): void {
    this.workspaceFsFactory = new AcpWorkspaceFileSystemFactory(conn);
  }

  private get fsFactory(): AcpWorkspaceFileSystemFactory | undefined {
    return this.workspaceFsFactory;
  }

  async checkAuthenticated(): Promise<boolean> {
    try {
      const status: any = await this.klient.global.auth.status();
      const providers: readonly any[] = status?.providers ?? [];
      return providers.some((p: any) => p?.hasToken === true);
    } catch {
      return false;
    }
  }

  async createSession(params: AcpCreateSessionParams): Promise<AcpSessionHost> {
    const ctx = this.fsFactory !== undefined
      ? { workspaceFileSystemFactory: this.fsFactory }
      : { workspaceFileSystemFactory: undefined };
    const result: any = await this.runtime.hostedSessions.create(
      {
        sessionId: params.sessionId,
        workDir: params.workDir ?? process.cwd(),
        additionalDirs: undefined,
        mcpServers: params.mcpServers,
      },
      ctx,
    );
    return new V2SessionAdapter(this.klient, result.id);
  }

  async resumeSession(params: AcpResumeSessionParams): Promise<AcpSessionHost> {
    const ctx = this.fsFactory !== undefined
      ? { workspaceFileSystemFactory: this.fsFactory }
      : { workspaceFileSystemFactory: undefined };
    const result: any = await this.runtime.hostedSessions.resume(
      params.sessionId,
      {
        additionalDirs: undefined,
        mcpServers: params.mcpServers,
      },
      ctx,
    );
    if (result === undefined || result === null) {
      throw Object.assign(new Error('session not found'), { code: 'session.not_found' });
    }
    return new V2SessionAdapter(this.klient, params.sessionId);
  }

  async listSessions(params?: AcpListSessionsParams): Promise<AcpSessionSummary[]> {
    try {
      const page: any = await this.klient.global.sessions.list({
        workDir: params?.workDir,
        cursor: undefined,
        limit: 100,
      } as any);
      const items: readonly any[] = page?.items ?? [];
      return items.map((s: any) => ({
        id: String(s?.id ?? ''),
        workDir: typeof s?.workDir === 'string' ? s.workDir : undefined,
        title: typeof s?.title === 'string' ? s.title : null,
        updatedAt: typeof s?.updatedAt === 'number' ? new Date(s.updatedAt).toISOString() : null,
      }));
    } catch {
      return [];
    }
  }

  async listAvailableModels() {
    return listModelsFromKlient(this.klient);
  }

  imageLimits = undefined;

  track(event: string, properties?: Record<string, unknown>): void {
    if (typeof this.runtime.telemetry?.track === 'function') {
      this.runtime.telemetry.track(event, properties);
    }
  }
}
