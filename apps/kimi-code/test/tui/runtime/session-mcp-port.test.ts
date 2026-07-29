/**
 * Scenario: MCP state and reconnect control cross the active-session TUI runtime boundary.
 * Responsibilities: the Klient adapter copies neutral server views, targets reconnect correctly,
 * and exposes the initial-load duration. Each runtime session facade is the single stub.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-mcp-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionMcpPort } from '#/tui/runtime/klient-session-mcp-adapter';

describe('Klient session MCP adapter', () => {
  it('list returns copied neutral server views from the selected Klient agent', async () => {
    const server = failedServer();
    const servers = [server];
    const rig = klientSession({
      list: vi.fn(async () => servers),
    });
    const port = createKlientSessionMcpPort(rig.session, 'worker');

    const result = await port.list();

    expect(result).toEqual([
      {
        name: 'example-server',
        transport: 'stdio',
        status: 'failed',
        toolCount: 0,
        error: 'Connection failed.',
      },
    ]);
    expect(result).not.toBe(servers);
    expect(result[0]).not.toBe(server);
    expect(rig.session.agent).toHaveBeenCalledWith('worker');
  });

  it('reconnect forwards the server name to the selected Klient agent', async () => {
    const reconnect = vi.fn(async () => undefined);
    const rig = klientSession({ reconnect });
    const port = createKlientSessionMcpPort(rig.session, 'worker');

    await port.reconnect('example-server');

    expect(reconnect).toHaveBeenCalledWith('example-server');
  });

  it('initialLoadDurationMs returns the selected Klient agent startup duration', async () => {
    const rig = klientSession({
      initialLoadDurationMs: vi.fn(async () => 250),
    });
    const port = createKlientSessionMcpPort(rig.session, 'worker');

    const result = await port.initialLoadDurationMs();

    expect(result).toBe(250);
  });
});

interface McpServerFixture {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

function failedServer(): McpServerFixture {
  return {
    name: 'example-server',
    transport: 'stdio',
    status: 'failed',
    toolCount: 0,
    error: 'Connection failed.',
  };
}

function klientSession(
  overrides: Partial<{
    list: () => Promise<readonly McpServerFixture[]>;
    reconnect: (name: string) => Promise<void>;
    initialLoadDurationMs: () => Promise<number>;
  }> = {},
) {
  const mcp = {
    list: overrides.list ?? vi.fn(async () => []),
    reconnect: overrides.reconnect ?? vi.fn(async () => undefined),
    initialLoadDurationMs:
      overrides.initialLoadDurationMs ?? vi.fn(async () => 0),
  };
  return {
    session: {
      agent: vi.fn((_agentId: string) => ({ mcp })),
    },
    mcp,
  };
}
