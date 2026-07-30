/**
 * Scenario: user-level MCP catalog CRUD and persistence compatibility.
 *
 * Exercises the real `IMcpCatalogService` against an isolated home directory,
 * including remote OAuth marker round-trips and preservation of unknown root
 * fields. Logging and bootstrap are the only stubbed boundaries. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/mcpCatalog/mcpCatalog.test.ts`.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import {
  IMcpCatalogService,
  type McpCatalogEntry,
} from '#/app/mcpCatalog/mcpCatalog';
import { McpCatalogService } from '#/app/mcpCatalog/mcpCatalogService';
import { registerLogServices } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

describe('McpCatalogService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    tmpDir = join(tmpdir(), `mcp-catalog-test-${randomUUID()}`);
    homeDir = join(tmpDir, 'home');
    await mkdir(homeDir, { recursive: true });

    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
        reg.define(IMcpCatalogService, McpCatalogService);
      },
    });
  });

  afterEach(async () => {
    disposables.dispose();
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('lists an empty catalog when no file exists', async () => {
    const svc = ix.get(IMcpCatalogService);
    const entries = await svc.list();
    expect(entries).toEqual([]);
  });

  it('adds a server and lists it', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'node', args: ['-v'] };
    const entry = await svc.add('test-server', config);
    expect(entry.name).toBe('test-server');
    expect(entry.config).toEqual(config);
    expect(entry.source).toBe('user');

    const entries = await svc.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('test-server');
  });

  it('throws on duplicate add', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'echo' };
    await svc.add('dup', config);
    await expect(svc.add('dup', config)).rejects.toThrow('already exists');
  });

  it('gets a server by name', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'node' };
    await svc.add('get-me', config);
    const entry = await svc.get('get-me');
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('get-me');
  });

  it('returns undefined for unknown server', async () => {
    const svc = ix.get(IMcpCatalogService);
    const entry = await svc.get('nonexistent');
    expect(entry).toBeUndefined();
  });

  it('updates an existing server', async () => {
    const svc = ix.get(IMcpCatalogService);
    const orig = { transport: 'stdio' as const, command: 'original' };
    await svc.add('upd', orig);
    const updated = { transport: 'stdio' as const, command: 'updated' };
    const entry = await svc.update('upd', updated);
    const cmd = (entry.config as { command: string }).command;
    expect(cmd).toBe('updated');
  });

  it('throws on update of non-existent server', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'nope' };
    await expect(svc.update('nobody', config)).rejects.toThrow('not found');
  });

  it('renames a server', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'echo' };
    await svc.add('old-name', config);
    const entry = await svc.rename('old-name', 'new-name');
    expect(entry.name).toBe('new-name');

    const old = await svc.get('old-name');
    expect(old).toBeUndefined();
    const nu = await svc.get('new-name');
    expect(nu).toBeDefined();
  });

  it('throws when renaming to an existing name', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'a' };
    await svc.add('a', config);
    await svc.add('b', config);
    await expect(svc.rename('a', 'b')).rejects.toThrow('already exists');
  });

  it('throws when renaming a non-existent server', async () => {
    const svc = ix.get(IMcpCatalogService);
    await expect(svc.rename('ghost', 'new')).rejects.toThrow('not found');
  });

  it('removes a server', async () => {
    const svc = ix.get(IMcpCatalogService);
    const config = { transport: 'stdio' as const, command: 'rm-me' };
    await svc.add('rm-me', config);
    await svc.remove('rm-me');
    const entries = await svc.list();
    expect(entries).toEqual([]);
  });

  it('throws on remove of non-existent server', async () => {
    const svc = ix.get(IMcpCatalogService);
    await expect(svc.remove('nobody')).rejects.toThrow('not found');
  });

  it('resets the catalog to empty', async () => {
    const svc = ix.get(IMcpCatalogService);
    await svc.add('a', { transport: 'stdio' as const, command: 'a' });
    await svc.add('b', { transport: 'stdio' as const, command: 'b' });
    await svc.reset();
    const entries = await svc.list();
    expect(entries).toEqual([]);
  });

  it('round-trips OAuth compatibility markers for remote transports', async () => {
    const svc = ix.get(IMcpCatalogService);
    const httpConfig = {
      transport: 'http' as const,
      url: 'https://http.example.test/mcp',
      auth: 'oauth' as const,
    };
    const sseConfig = {
      transport: 'sse' as const,
      url: 'https://sse.example.test/events',
      auth: 'oauth' as const,
    };

    await svc.add('oauth-http', httpConfig);
    await svc.add('oauth-sse', sseConfig);

    await expect(svc.get('oauth-http')).resolves.toEqual({
      name: 'oauth-http',
      config: httpConfig,
      source: 'user',
    });
    await expect(svc.get('oauth-sse')).resolves.toEqual({
      name: 'oauth-sse',
      config: sseConfig,
      source: 'user',
    });
  });

  it('preserves unknown top-level fields when writing', async () => {
    const userJson = JSON.stringify({
      mcpServers: {
        existing: {
          transport: 'http',
          url: 'https://existing.example.test/mcp',
          auth: 'oauth',
        },
      },
      $custom: 'keep-me',
      _comment: 'do not lose',
    });
    await writeFile(join(homeDir, 'mcp.json'), userJson);

    const svc = ix.get(IMcpCatalogService);
    await svc.add('new-one', { transport: 'stdio' as const, command: 'new' });

    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(join(homeDir, 'mcp.json'), 'utf-8'));
    expect(raw['$custom']).toBe('keep-me');
    expect(raw['_comment']).toBe('do not lose');
    expect(raw.mcpServers['existing']).toEqual({
      transport: 'http',
      url: 'https://existing.example.test/mcp',
      auth: 'oauth',
    });
    expect(raw.mcpServers['new-one']).toBeDefined();
  });
});
