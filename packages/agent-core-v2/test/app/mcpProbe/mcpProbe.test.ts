/**
 * Tests for `IMcpProbeService` — one-shot MCP server connectivity probing.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { cwdStdioFixture } from '../../session/mcp/stubs';

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

  it('uses the caller cwd as the stdio default without changing the server config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kimi-mcp-probe-cwd-'));
    try {
      const svc = ix.get(IMcpProbeService);
      const result = await svc.probe(
        'cwd',
        {
          transport: 'stdio',
          command: process.execPath,
          args: [cwdStdioFixture],
          env: { EXPECTED_CWD: cwd },
        },
        { cwd },
      );

      expect(result).toEqual({
        serverName: 'cwd',
        success: true,
        toolCount: 1,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});
