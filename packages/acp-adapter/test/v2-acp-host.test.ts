import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { Klient } from '@moonshot-ai/klient';
import { describe, expect, it, vi } from 'vitest';

import { AcpWorkspaceFileSystemFactory } from '../src/acp-workspace-file-system-factory';
import {
  V2AcpHost,
  type AcpHostedRuntime,
} from '../src/v2-acp-host';

function runtimeWithGlobal(global: Klient['global']): AcpHostedRuntime {
  const klient = {
    global,
    session: () => ({
      agent: () => ({
        replay: { read: vi.fn().mockRejectedValue(new Error('not persisted')) },
      }),
    }),
    events: {},
    close: vi.fn(),
  } as unknown as Klient;
  return {
    klient,
    hostedSessions: {
      create: vi.fn().mockResolvedValue({ id: 'session-1' }),
      resume: vi.fn().mockResolvedValue({ id: 'session-1' }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function mockGlobal(overrides: Partial<Klient['global']> = {}): Klient['global'] {
  return {
    sessions: {
      list: vi.fn().mockResolvedValue({ items: [] }),
    },
    workspaces: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
    },
    config: {
      get: vi.fn(),
    },
    kosong: {
      listModels: vi.fn().mockResolvedValue([]),
    },
    auth: {
      ensureReady: vi.fn(),
    },
    ...overrides,
  } as unknown as Klient['global'];
}

describe('V2AcpHost', () => {
  it('passes the ACP-bound workspace filesystem factory to hosted session creation', async () => {
    const runtime = runtimeWithGlobal(mockGlobal());
    const host = new V2AcpHost(runtime);
    const connection = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(),
    } as unknown as AgentSideConnection;
    host.bindConnection(connection);

    await host.createSession({ sessionId: 'session-1', workDir: '/workspace' });

    expect(runtime.hostedSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        workDir: '/workspace',
      }),
      {
        workspaceFileSystemFactory: expect.any(AcpWorkspaceFileSystemFactory),
      },
    );
  });

  it('reads every session page and propagates transport failures', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{
          id: 'one',
          workspaceId: 'workspace-1',
          cwd: '/workspace',
          updatedAt: 1,
        }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [{
          id: 'two',
          workspaceId: 'workspace-1',
          cwd: '/workspace',
          updatedAt: 2,
        }],
      });
    const runtime = runtimeWithGlobal(
      mockGlobal({
        sessions: { list } as unknown as Klient['global']['sessions'],
      }),
    );
    const host = new V2AcpHost(runtime);

    await expect(host.listSessions()).resolves.toHaveLength(2);
    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: undefined }));
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page-2' }));

    list.mockReset();
    list.mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(host.listSessions()).rejects.toThrow('transport unavailable');
  });

  it('resolves the default model and effective thinking from config and catalog', async () => {
    const get = vi.fn(async (domain: string) => {
      if (domain === 'defaultModel') return '  kimi-thinking  ';
      if (domain === 'thinking') return { enabled: true, effort: 'on' };
      return undefined;
    });
    const runtime = runtimeWithGlobal(
      mockGlobal({
        config: { get } as unknown as Klient['global']['config'],
        kosong: {
          listModels: vi.fn().mockResolvedValue([{
            provider: 'kimi',
            model: 'kimi-thinking',
            max_context_size: 128_000,
            capabilities: ['thinking'],
            support_efforts: ['low', 'high'],
            default_effort: 'high',
          }]),
        } as unknown as Klient['global']['kosong'],
      }),
    );
    const host = new V2AcpHost(runtime);

    await expect(host.getDefaultModelId()).resolves.toBe('kimi-thinking');
    await expect(host.getDefaultThinkingEffort()).resolves.toBe('high');
  });
});
