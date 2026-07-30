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
import type { IWorkspaceFileSystemFactory } from '@moonshot-ai/agent-core-v2/os/interface/workspaceFileSystem';
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

  constructor(private readonly runtime: AcpHostedRuntime) {}

  /** Called by AcpServer once the AgentSideConnection is available. */
  bindConnection(conn: AgentSideConnection): void {
    this.workspaceFsFactory = new AcpWorkspaceFileSystemFactory(conn);
  }

  private get fsFactory(): AcpWorkspaceFileSystemFactory | undefined {
    return this.workspaceFsFactory;
  }

  async checkAuthenticated(): Promise<boolean> {
    try {
      await this.runtime.klient.global.auth.ensureReady();
      return true;
    } catch {
      return false;
    }
  }

  async createSession(params: AcpCreateSessionParams): Promise<AcpSessionHost> {
    const result = await this.runtime.hostedSessions.create(
      {
        sessionId: params.sessionId,
        workDir: params.workDir ?? process.cwd(),
        additionalDirs: params.additionalDirs,
        mcpServers: params.mcpServers,
      },
      { workspaceFileSystemFactory: this.fsFactory },
    );
    return new V2SessionAdapter(this.runtime.klient, result.id);
  }

  async resumeSession(params: AcpResumeSessionParams): Promise<AcpSessionHost> {
    const result = await this.runtime.hostedSessions.resume(
      params.sessionId,
      {
        additionalDirs: params.additionalDirs,
        mcpServers: params.mcpServers,
      },
      { workspaceFileSystemFactory: this.fsFactory },
    );
    if (result === undefined) {
      throw Object.assign(new Error('session not found'), { code: 'session.not_found' });
    }
    return new V2SessionAdapter(this.runtime.klient, params.sessionId);
  }

  async listSessions(params?: AcpListSessionsParams): Promise<AcpSessionSummary[]> {
    const workspaceIds =
      params?.workDir === undefined
        ? undefined
        : (await this.runtime.klient.global.workspaces.list())
            .filter((workspace) => workspace.root === params.workDir)
            .map((workspace) => workspace.id);
    if (workspaceIds !== undefined && workspaceIds.length === 0) return [];

    const summaries: AcpSessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.runtime.klient.global.sessions.list({
        workspaceIds,
        sessionId: params?.sessionId,
        cursor,
        limit: 100,
      });
      summaries.push(
        ...(await Promise.all(
          page.items.map(async (session) => {
            const workDir =
              session.cwd ??
              (await this.runtime.klient.global.workspaces.get(session.workspaceId))?.root;
            if (workDir === undefined) {
              throw new Error(`Workspace "${session.workspaceId}" is unavailable`);
            }
            return {
              id: session.id,
              workDir,
              title: session.title ?? null,
              updatedAt: new Date(session.updatedAt).toISOString(),
            };
          }),
        )),
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return summaries;
  }

  async listAvailableModels() {
    return listModelsFromKlient(this.runtime.klient);
  }

  async getDefaultModelId(): Promise<string | undefined> {
    const modelId =
      await this.runtime.klient.global.config.get<string | undefined>('defaultModel');
    return nonEmpty(modelId);
  }

  async getDefaultThinkingEffort(): Promise<string | undefined> {
    const [modelId, thinking, models] = await Promise.all([
      this.getDefaultModelId(),
      this.runtime.klient.global.config.get<{
        readonly enabled?: boolean;
        readonly effort?: string;
      } | undefined>('thinking'),
      this.runtime.klient.global.kosong.listModels(),
    ]);
    const model = models.find((candidate) => candidate.model === modelId);
    const capabilities = model?.capabilities ?? [];
    const alwaysThinking = capabilities.includes('always_thinking');
    const supportsThinking =
      alwaysThinking || capabilities.includes('thinking');
    if (!supportsThinking) return 'off';

    const configured = nonEmpty(thinking?.effort)?.toLowerCase();
    const modelDefault = nonEmpty(model?.default_effort)?.toLowerCase() ?? 'on';
    if (thinking?.enabled === false && !alwaysThinking) return 'off';
    if (configured === 'off' && alwaysThinking) return modelDefault;
    if (configured !== undefined) {
      const supportedEfforts = model?.support_efforts ?? [];
      if (configured === 'on' && supportedEfforts.length > 0) return modelDefault;
      return configured;
    }
    return modelDefault;
  }

  track(event: string, properties?: Record<string, unknown>): void {
    this.runtime.telemetry?.track(event, telemetryProperties(properties));
  }

  close(): Promise<void> {
    return this.runtime.close();
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export interface AcpHostedRuntime {
  readonly klient: Klient;
  readonly hostedSessions: {
    create(
      input: AcpHostedCreateInput,
      overrides: AcpHostedSessionOverrides,
    ): Promise<{ readonly id: string }>;
    resume(
      sessionId: string,
      input: AcpHostedResumeInput,
      overrides: AcpHostedSessionOverrides,
    ): Promise<{ readonly id: string } | undefined>;
  };
  readonly telemetry?: {
    track(
      event: string,
      properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
    ): void;
  };
  close(): Promise<void>;
}

interface AcpHostedCreateInput {
  readonly sessionId: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: AcpCreateSessionParams['mcpServers'];
}

interface AcpHostedResumeInput {
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: AcpResumeSessionParams['mcpServers'];
}

interface AcpHostedSessionOverrides {
  readonly workspaceFileSystemFactory?: IWorkspaceFileSystemFactory;
}

function telemetryProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null | undefined> | undefined {
  if (properties === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(properties).filter(
      (entry): entry is [
        string,
        string | number | boolean | null | undefined,
      ] =>
        entry[1] === undefined ||
        entry[1] === null ||
        typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean',
    ),
  );
}
