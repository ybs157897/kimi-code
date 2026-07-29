/**
 * `mcpOAuth` domain (L5) — `IMcpOAuthService` implementation.
 *
 * Wraps the existing `McpOAuthService` from the `mcp` session domain,
 * adding a `flowId`-based pending-flow map so authorization operations are
 * JSON-safe for Klient exposure. The underlying provider map and OAuth
 * logic live on the wrapped service — this App-scoped service is the sole
 * owner of that state. Persists credentials through `IAtomicDocumentStore`
 * (via `mcp/oauth/store`). Bound at App scope.
 */

import { randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  McpOAuthService,
  type BeginAuthorizationResult,
} from '#/session/mcp/oauth/service';
import { createMcpOAuthStore } from '#/session/mcp/oauth/store';
import type { McpOAuthClientProvider } from '#/session/mcp/oauth/provider';

import {
  type IMcpOAuthService,
  type McpBeginAuthorizationFlowResult,
  IMcpOAuthService as IMcpOAuthServiceToken,
} from './mcpOAuth';

interface PendingFlow {
  readonly serverName: string;
  readonly serverUrl: string | URL;
  readonly result: BeginAuthorizationResult;
}

export class McpOAuthServiceImpl extends Disposable implements IMcpOAuthService {
  declare readonly _serviceBrand: undefined;

  private readonly inner: McpOAuthService;
  private readonly flows = new Map<string, PendingFlow>();

  constructor(
    @IAtomicDocumentStore atomicDocs: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.inner = new McpOAuthService({
      store: createMcpOAuthStore(atomicDocs),
    });
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    return this.inner.getProvider(serverName, serverUrl);
  }

  hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean> {
    return this.inner.hasTokens(serverName, serverUrl);
  }

  beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
  ): Promise<BeginAuthorizationResult> {
    return this.inner.beginAuthorization(serverName, serverUrl);
  }

  async beginAuthorizationWithFlowId(
    serverName: string,
    serverUrl: string | URL,
  ): Promise<McpBeginAuthorizationFlowResult> {
    const result = await this.inner.beginAuthorization(serverName, serverUrl);
    const flowId = randomUUID();
    this.flows.set(flowId, { serverName, serverUrl, result });
    return {
      flowId,
      authorizationUrl: result.authorizationUrl.toString(),
    };
  }

  async completeAuthorization(
    flowId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    const flow = this.flows.get(flowId);
    if (flow === undefined) {
      throw new Error(`OAuth flow "${flowId}" not found`);
    }
    try {
      await flow.result.complete(opts);
    } finally {
      this.flows.delete(flowId);
    }
  }

  async cancelAuthorization(flowId: string): Promise<void> {
    const flow = this.flows.get(flowId);
    if (flow === undefined) return;
    try {
      await flow.result.cancel();
    } finally {
      this.flows.delete(flowId);
    }
  }

  async invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    await this.inner.invalidate(serverName, serverUrl, scope);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthServiceToken,
  McpOAuthServiceImpl,
  ScopeActivation.OnDemand,
  'mcpOAuth',
);
