/**
 * Scenario: `/mcp` renders session-local servers through the active TUI runtime.
 * Responsibility: the panel consumes the neutral MCP view and the command routes
 * listing and load failures through the session MCP port.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/messages/mcp-status-panel.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { showMcpServers } from '#/tui/commands/info';
import { buildMcpStatusReportLines } from '#/tui/components/messages/mcp-status-panel';
import type { McpServerView } from '#/tui/runtime/session-mcp-port';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface RenderablePanel {
  render(width: number): string[];
}

function makeMcpHost(list: () => Promise<readonly McpServerView[]>) {
  const panels: RenderablePanel[] = [];
  const requestRender = vi.fn();
  const showError = vi.fn();
  const requireSessionRuntime = vi.fn(() => ({
    mcp: { list },
  }));
  const host = {
    state: {
      transcriptContainer: {
        addChild: (panel: RenderablePanel) => panels.push(panel),
      },
      ui: { requestRender },
    },
    requireSessionRuntime,
    showError,
  } as unknown as Parameters<typeof showMcpServers>[0];

  return { host, panels, requestRender, requireSessionRuntime, showError };
}

describe('buildMcpStatusReportLines', () => {
  it('folds a multi-line server error onto one row so the panel box stays intact', () => {
    const servers: readonly McpServerView[] = [
      {
        name: 'ghidra',
        transport: 'stdio',
        status: 'failed',
        toolCount: 0,
        error:
          'MCP error -32000: Connection closed\nstderr: usage: bridge_mcp_ghidra.py [-h] [--mcp-host MCP_HOST]',
      },
    ];
    const lines = buildMcpStatusReportLines({
      servers,
    }).map(strip);

    // The box renderer (UsagePanelComponent.render) treats each returned string
    // as exactly one row, so an embedded newline would punch through the border.
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }

    const errorLine = lines.find((line) => line.includes('error:'));
    expect(errorLine).toContain(
      'MCP error -32000: Connection closed stderr: usage: bridge_mcp_ghidra.py [-h] [--mcp-host MCP_HOST]',
    );
  });

  it('trims and keeps a single-line error intact', () => {
    const lines = buildMcpStatusReportLines({
      servers: [
        {
          name: 'ida',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: '  fetch failed  ',
        },
      ],
    }).map(strip);

    const errorLine = lines.find((line) => line.includes('error:'));
    expect(errorLine).toContain('error: fetch failed');
  });
});

describe('showMcpServers', () => {
  it('lists servers through the active runtime MCP port', async () => {
    const list = vi.fn(async (): Promise<readonly McpServerView[]> => [
      {
        name: 'docs',
        transport: 'http',
        status: 'connected',
        toolCount: 2,
      },
    ]);
    const { host, panels, requestRender, requireSessionRuntime, showError } = makeMcpHost(list);

    await showMcpServers(host);

    expect(requireSessionRuntime).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.render(120).map(strip).join('\n')).toContain(
      'docs  connected  http       2 tools',
    );
  });

  it('reports runtime MCP list failures without mounting a panel', async () => {
    const list = vi.fn(async (): Promise<readonly McpServerView[]> => {
      throw new Error('No active session');
    });
    const { host, panels, requestRender, showError } = makeMcpHost(list);

    await showMcpServers(host);

    expect(list).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith('Failed to load MCP servers: No active session');
    expect(requestRender).not.toHaveBeenCalled();
    expect(panels).toHaveLength(0);
  });
});
