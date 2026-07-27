/**
 * Scenario: `/status` renders session-local status through the active TUI runtime.
 * Responsibilities: the panel consumes neutral runtime/model DTOs, preserves
 * model-display fallbacks, and retains runtime status/managed-usage errors.
 * Wiring: report formatting is real; command tests stub only runtime queries.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/messages/status-panel.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { showStatusReport } from '#/tui/commands/info';
import { buildStatusReportLines } from '#/tui/components/messages/status-panel';
import type { RuntimeManagedUsageResult } from '#/tui/runtime/runtime-auth-port';
import type { AgentRuntimeStatus } from '#/tui/runtime/session-control-port';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface RenderablePanel {
  render(width: number): string[];
}

interface StatusHostOptions {
  readonly provider?: string;
  readonly getManagedUsage?: (
    provider?: string,
  ) => Promise<RuntimeManagedUsageResult>;
}

function makeStatusHost(
  getStatus: () => Promise<AgentRuntimeStatus>,
  options: StatusHostOptions = {},
) {
  const panels: RenderablePanel[] = [];
  const requestRender = vi.fn();
  const getManagedUsage =
    options.getManagedUsage ??
    vi.fn(async (): Promise<RuntimeManagedUsageResult> => ({
      kind: 'error',
      message: 'Managed usage unavailable.',
    }));
  const requireSessionRuntime = vi.fn(() => ({
    agent: { getStatus },
  }));
  const host = {
    state: {
      appState: {
        version: '1.2.3',
        model: 'k2',
        workDir: '/tmp/project',
        sessionId: 'ses-1',
        sessionTitle: 'Implement status',
        thinkingEffort: 'on',
        permissionMode: 'manual',
        planMode: false,
        contextUsage: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        availableModels: {
          k2: {
            provider: options.provider ?? 'example',
            model: 'kimi-k2',
            maxContextSize: 10000,
            displayName: 'Kimi K2',
          },
        },
      },
      transcriptContainer: {
        addChild: (panel: RenderablePanel) => panels.push(panel),
      },
      ui: { requestRender },
    },
    harness: { auth: {} },
    runtime: { auth: { getManagedUsage } },
    requireSessionRuntime,
  } as unknown as Parameters<typeof showStatusReport>[0];

  return {
    host,
    panels,
    requestRender,
    requireSessionRuntime,
    getManagedUsage,
  };
}

describe('status panel report lines', () => {
  it('formats runtime status, context, and managed usage without account or AGENTS.md rows', () => {
    const status: AgentRuntimeStatus = {
      model: 'k2',
      thinkingEffort: 'high',
      permission: 'auto',
      planMode: true,
      contextTokens: 3000,
      maxContextTokens: 12000,
      contextUsage: 0.25,
    };
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'Implement status',
      thinkingEffort: 'on',
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      availableModels: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 10000,
          displayName: 'Kimi K2',
        },
      },
      status,
      managedUsage: {
        summary: null,
        limits: [
          {
            label: '5h limit',
            used: 8,
            limit: 100,
            resetHint: 'resets in 1h',
          },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('>_ Kimi Code (v1.2.3)');
    expect(output).toContain('Model        Kimi K2 (thinking high)');
    expect(output).toContain('Directory    /tmp/project');
    expect(output).toContain('Permissions  auto');
    expect(output).toContain('Plan mode    on');
    expect(output).toContain('Session      ses-1');
    expect(output).toContain('Title        Implement status');
    expect(output).toContain('Context window');
    expect(output).toContain('25%');
    expect(output).toContain('(2.9k / 11.7k)');
    expect(output).toContain('Plan usage');
    expect(output).toContain('8% used');
    expect(output).not.toContain('Account');
    expect(output).not.toContain('AGENTS.md');
    expect(output).not.toContain('Runtime');
  });

  it('formats extra usage section in status report', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 15000,
          totalCents: 20000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 20000,
          monthlyUsedCents: 5000,
          currency: 'USD',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('150.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
  });

  it('falls back to app state and shows status load errors as warnings', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: '',
      workDir: '/tmp/project',
      sessionId: '',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      statusError: 'No active session',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Model        not set');
    expect(output).toContain('Session      none');
    expect(output).toContain('Warning      No active session');
    expect(output).toContain('No context window data available.');
  });
});

describe('status panel model display', () => {
  it('renders the override when a model supplies a displayName override', () => {
    const output = buildStatusReportLines({
      version: '1.2.3',
      model: 'active-alias',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'xhigh',
      permissionMode: 'yolo',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {
        'active-alias': {
          provider: 'example-provider',
          model: 'runtime-model-name',
          maxContextSize: 10000,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    })
      .map(strip)
      .join('\n');

    expect(output).toContain('Model        Custom Name (thinking xhigh)');
    expect(output).not.toContain('Remote Name');
  });

  it('falls back to the catalog model name when displayName is absent', () => {
    const output = buildStatusReportLines({
      version: '1.2.3',
      model: 'active-alias',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {
        'active-alias': {
          provider: 'example-provider',
          model: 'runtime-model-name',
          maxContextSize: 10000,
        },
      },
    })
      .map(strip)
      .join('\n');

    expect(output).toContain('Model        runtime-model-name (thinking off)');
  });

  it('falls back to the active alias when the model is absent from the catalog', () => {
    const output = buildStatusReportLines({
      version: '1.2.3',
      model: 'active-alias',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'on',
      permissionMode: 'auto',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
    })
      .map(strip)
      .join('\n');

    expect(output).toContain('Model        active-alias (thinking on)');
  });
});

describe('showStatusReport', () => {
  it('queries the active runtime once and renders its status', async () => {
    const getStatus = vi.fn(async (): Promise<AgentRuntimeStatus> => ({
      model: 'k2',
      thinkingEffort: 'high',
      permission: 'auto',
      planMode: true,
      contextTokens: 3000,
      maxContextTokens: 12000,
      contextUsage: 0.25,
    }));
    const { host, panels, requestRender, requireSessionRuntime } = makeStatusHost(getStatus);

    await showStatusReport(host);

    expect(requireSessionRuntime).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(panels).toHaveLength(1);
    const output = panels[0]!.render(120).map(strip).join('\n');
    expect(output).toContain('Permissions  auto');
    expect(output).toContain('Plan mode    on');
    expect(output).toContain('(2.9k / 11.7k)');
  });

  it('renders the runtime status error as a warning', async () => {
    const getStatus = vi.fn(async (): Promise<AgentRuntimeStatus> => {
      throw new Error('No active session');
    });
    const { host, panels } = makeStatusHost(getStatus);

    await showStatusReport(host);

    expect(getStatus).toHaveBeenCalledOnce();
    expect(panels[0]!.render(120).map(strip).join('\n')).toContain(
      'Warning      No active session',
    );
  });

  it('renders managed usage errors returned by runtime auth', async () => {
    const getStatus = vi.fn(async (): Promise<AgentRuntimeStatus> => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
    }));
    const getManagedUsage = vi.fn(
      async (): Promise<RuntimeManagedUsageResult> => ({
        kind: 'error',
        message: 'Plan usage is temporarily unavailable.',
        status: 503,
      }),
    );
    const { host, panels } = makeStatusHost(getStatus, {
      provider: 'managed:kimi-code',
      getManagedUsage,
    });

    await showStatusReport(host);

    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code');
    expect(panels[0]!.render(120).map(strip).join('\n')).toContain(
      'Plan usage is temporarily unavailable.',
    );
  });

  it('skips managed usage lookup for a non-managed provider', async () => {
    const getStatus = vi.fn(async (): Promise<AgentRuntimeStatus> => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
    }));
    const { host, getManagedUsage } = makeStatusHost(getStatus, {
      provider: 'example-provider',
    });

    await showStatusReport(host);

    expect(getManagedUsage).not.toHaveBeenCalled();
  });
});
