/**
 * Tests for `IMcpProbeService` — one-shot MCP server connectivity probing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import {
  IMcpProbeService,
  type IMcpProbeService as IMcpProbeServiceType,
  type McpProbeResult,
} from '#/app/mcpProbe/mcpProbe';
import { McpProbeServiceImpl } from '#/app/mcpProbe/mcpProbeService';
import { registerLogServices } from '../../_base/log/stubs';

describe('McpProbeService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.define(IMcpProbeService, McpProbeServiceImpl);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('returns failure for an unreachable HTTP server', async () => {
    const svc = ix.get(IMcpProbeService);
    const result = await svc.probe('unreachable', {
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
    });

    expect(result.success).toBe(false);
    expect(result.serverName).toBe('unreachable');
    expect(result.toolCount).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('returns failure for a missing command', async () => {
    const svc = ix.get(IMcpProbeService);
    const result = await svc.probe('missing-cmd', {
      transport: 'stdio',
      command: 'nonexistent-command-xyz',
    });

    expect(result.success).toBe(false);
    expect(result.serverName).toBe('missing-cmd');
    expect(result.error).toBeDefined();
  });
});
