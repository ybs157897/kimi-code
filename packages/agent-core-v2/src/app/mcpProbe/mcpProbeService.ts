/**
 * `mcpProbe` domain (L5) — `IMcpProbeService` implementation.
 *
 * Creates a throwaway MCP client per probe call, connects, lists tools,
 * and disconnects. Success and failure both clean up. Logs through `log`.
 * Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { StdioMcpClient } from '#/session/mcp/client-stdio';
import { HttpMcpClient } from '#/session/mcp/client-http';
import { SseMcpClient } from '#/session/mcp/client-sse';

import {
  type IMcpProbeService,
  type McpProbeResult,
  IMcpProbeService as IMcpProbeServiceToken,
} from './mcpProbe';

type ProbeClient = StdioMcpClient | HttpMcpClient | SseMcpClient;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export class McpProbeServiceImpl extends Disposable implements IMcpProbeService {
  declare readonly _serviceBrand: undefined;

  constructor(@ILogService private readonly log: ILogService) {
    super();
  }

  async probe(serverName: string, config: McpServerConfig): Promise<McpProbeResult> {
    let client: ProbeClient | undefined;
    try {
      client = this.createClient(config);
      await client.connect();

      const tools = await withTimeout(
        client.listTools(),
        config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );

      return { serverName, success: true, toolCount: tools.length };
    } catch (error: unknown) {
      return {
        serverName,
        success: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (client !== undefined) {
        try {
          await client.close();
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  private createClient(config: McpServerConfig): ProbeClient {
    const startupTimeoutMs =
      config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs: config.toolTimeoutMs,
      });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        startupTimeoutMs,
        toolCallTimeoutMs: config.toolTimeoutMs,
      });
    }
    return new HttpMcpClient(config, {
      startupTimeoutMs,
      toolCallTimeoutMs: config.toolTimeoutMs,
    });
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpProbeServiceToken,
  McpProbeServiceImpl,
  ScopeActivation.OnDemand,
  'mcpProbe',
);
