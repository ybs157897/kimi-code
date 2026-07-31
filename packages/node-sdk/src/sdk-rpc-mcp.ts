import { ErrorCodes, KimiError } from '#/sdk-errors';
import {
  normalizeMcpServerName,
  normalizeNamedResource,
} from '#/sdk-rpc-normalize';
import type {
  Klient,
  V2McpCatalogEntry,
  V2McpServerConfig,
} from '#/sdk-rpc-types';
import type { McpServerConfig } from '#/types';

export function toV2McpCatalogInput(
  server: McpServerConfig,
): { readonly name: string; readonly config: V2McpServerConfig } {
  if (typeof server !== 'object' || server === null) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'MCP server config is required.');
  }
  const { name: rawName, ...config } = server;
  return {
    name: normalizeMcpServerName(rawName),
    config,
  };
}

export function toSdkMcpServerConfig(entry: V2McpCatalogEntry): McpServerConfig {
  return {
    ...entry.config,
    name: entry.name,
  };
}

export async function listSdkMcpServers(
  klient: Klient,
): Promise<readonly McpServerConfig[]> {
  return (await klient.global.mcp.catalog.list()).map(toSdkMcpServerConfig);
}

export async function requireMcpServer(
  klient: Klient,
  name: string,
): Promise<V2McpCatalogEntry> {
  const normalized = normalizeMcpServerName(name);
  const entry = await klient.global.mcp.catalog.get(normalized);
  if (entry !== undefined) return entry;
  throw new KimiError(
    ErrorCodes.MCP_SERVER_NOT_FOUND,
    `MCP server "${normalized}" was not found.`,
    { details: { name: normalized } },
  );
}

export type V2RemoteMcpServerConfig = Extract<
  V2McpServerConfig,
  { readonly transport: 'http' | 'sse' }
>;

export interface V2RemoteMcpCatalogEntry {
  readonly name: string;
  readonly config: V2RemoteMcpServerConfig;
}

export async function requireRemoteMcpServer(
  klient: Klient,
  name: string,
): Promise<V2RemoteMcpCatalogEntry> {
  const entry = await requireMcpServer(klient, name);
  if (entry.config.transport === 'http' || entry.config.transport === 'sse') {
    return { name: entry.name, config: entry.config };
  }
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${entry.name}" does not use a remote transport.`,
    { details: { name: entry.name, transport: entry.config.transport } },
  );
}

export async function completeMcpAuthorization(
  klient: Klient,
  input: { readonly flowId: string; readonly timeoutMs?: number },
  signal?: AbortSignal,
): Promise<void> {
  const flowId = normalizeNamedResource(input.flowId, 'MCP OAuth flow id');
  signal?.throwIfAborted();
  const completion = klient.global.mcp.oauth.complete({
    flowId,
    timeoutMs: input.timeoutMs,
  });
  if (signal === undefined) return completion;

  await new Promise<void>((resolveCompletion, rejectCompletion) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      void klient.global.mcp.oauth.cancel(flowId).finally(() => {
        settle(() => {
          rejectCompletion(abortReason(signal));
        });
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    completion.then(
      () => {
        settle(resolveCompletion);
      },
      (error: unknown) => {
        settle(() => {
          rejectCompletion(error);
        });
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function isAlreadyAuthorizedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AlreadyAuthorizedError' ||
      error.message.includes('already authorized'))
  );
}
