/**
 * Scenario: MCP state and reconnect control cross the active-session TUI runtime boundary.
 * Responsibilities: both adapters copy neutral server views, target reconnect correctly,
 * and expose the initial-load duration. Each runtime session facade is the single stub.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-mcp-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionMcpPort } from '#/tui/runtime/klient-session-mcp-adapter';
import { createLegacySessionMcpPort } from '#/tui/runtime/legacy-session-mcp-adapter';

describe('legacy session MCP adapter', () => {
  it('list returns copied neutral server views from a legacy session', async () => {
    const server = failedServer();
    const servers = [server];
    const session = legacySession({
      listMcpServers: vi.fn(async () => servers),
    });

    const result = await createLegacySessionMcpPort(session).list();

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
  });

  it('reconnect forwards the server name to a legacy session', async () => {
    const reconnectMcpServer = vi.fn(async () => undefined);
    const session = legacySession({ reconnectMcpServer });

    await createLegacySessionMcpPort(session).reconnect('example-server');

    expect(reconnectMcpServer).toHaveBeenCalledWith('example-server');
  });

  it('initialLoadDurationMs returns the legacy startup duration', async () => {
    const session = legacySession({
      getMcpStartupMetrics: vi.fn(async () => ({ durationMs: 125 })),
    });

    const result = await createLegacySessionMcpPort(
      session,
    ).initialLoadDurationMs();

    expect(result).toBe(125);
  });
});

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

function legacySession(
  overrides: Partial<{
    listMcpServers: () => Promise<readonly McpServerFixture[]>;
    reconnectMcpServer: (name: string) => Promise<void>;
    getMcpStartupMetrics: () => Promise<{ durationMs: number }>;
  }> = {},
) {
  return {
    listMcpServers: vi.fn(async () => []),
    reconnectMcpServer: vi.fn(async () => undefined),
    getMcpStartupMetrics: vi.fn(async () => ({ durationMs: 0 })),
    ...overrides,
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
