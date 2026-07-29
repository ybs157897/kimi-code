/**
 * `mcpOAuth` domain (L5) — App-scoped MCP OAuth management contract.
 *
 * Defines `IMcpOAuthService`, the process-level OAuth orchestrator for MCP
 * HTTP servers. Owns the provider map (one `McpOAuthClientProvider` per
 * server/resource identity) and the pending authorization flow map.
 *
 * Internal consumers (the auth tool, `McpConnectionManager`) use the raw
 * `beginAuthorization` / `getProvider` / `hasTokens` / `invalidate` methods.
 * Klient exposure uses the JSON-safe `flowId`-based
 * `beginAuthorizationWithFlowId` / `completeAuthorization` /
 * `cancelAuthorization` methods. Bound at App scope.
 */

import type { BeginAuthorizationResult } from '#/session/mcp/oauth/service';
import type { McpOAuthClientProvider } from '#/session/mcp/oauth/provider';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface McpBeginAuthorizationFlowResult {
  /** JSON-safe flow identifier for use in complete/cancel calls. */
  readonly flowId: string;
  /** The URL the user must visit to authorize. */
  readonly authorizationUrl: string;
}

export interface IMcpOAuthService {
  readonly _serviceBrand: undefined;

  /**
   * Return the (possibly cached) OAuth client provider for the given server,
   * creating it on first access. Used internally by `McpConnectionManager`.
   */
  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider;

  /** Check whether this server already has stored OAuth tokens. */
  hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean>;

  /**
   * Start the browser-based OAuth flow. Returns a raw result with
   * `complete`/`cancel` callbacks for internal consumers such as the MCP
   * auth tool.
   */
  beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
  ): Promise<BeginAuthorizationResult>;

  /**
   * Start the browser-based OAuth flow with a JSON-safe `flowId`.
   * Returns the `flowId` + `authorizationUrl` for Klient exposure.
   */
  beginAuthorizationWithFlowId(
    serverName: string,
    serverUrl: string | URL,
  ): Promise<McpBeginAuthorizationFlowResult>;

  /** Wait for the user to complete the browser flow and exchange the code. */
  completeAuthorization(flowId: string, opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<void>;

  /** Cancel a pending authorization flow. */
  cancelAuthorization(flowId: string): Promise<void>;

  /**
   * Remove stored credentials for a server. The `scope` parameter controls
   * which credentials are cleared (defaults to `'all'`).
   */
  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope?: 'all' | 'client' | 'tokens' | 'discovery',
  ): Promise<void>;
}

export const IMcpOAuthService: ServiceIdentifier<IMcpOAuthService> =
  createDecorator<IMcpOAuthService>('mcpOAuthService');
