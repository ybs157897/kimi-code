/**
 * Tests for `IMcpOAuthService` — flowId-based OAuth management.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import {
  IMcpOAuthService,
  type IMcpOAuthService as IMcpOAuthServiceType,
} from '#/app/mcpOAuth/mcpOAuth';
import { McpOAuthServiceImpl } from '#/app/mcpOAuth/mcpOAuthService';
import { registerLogServices } from '../../_base/log/stubs';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

function stubAtomicDocStore(): IAtomicDocumentStore {
  const data = new Map<string, unknown>();
  return {
    _serviceBrand: undefined,
    async get<T>(_scope: string, key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set(_scope: string, key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(_scope: string, key: string): Promise<void> {
      data.delete(key);
    },
    async list(_scope: string, _prefix?: string): Promise<readonly string[]> {
      return Array.from(data.keys());
    },
    watch(_scope: string, _key: string): import('#/_base/event').Event<void> {
      return () => ({ dispose() {} } as import('#/_base/di/lifecycle').IDisposable);
    },
    acquire(_scope: string, _key: string): import('#/_base/di/lifecycle').IDisposable {
      return { dispose() {} };
    },
  };
}

describe('McpOAuthService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IAtomicDocumentStore, stubAtomicDocStore());
        reg.define(IMcpOAuthService, McpOAuthServiceImpl);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('provides a provider for a given server', () => {
    const svc = ix.get(IMcpOAuthService);
    const provider = svc.getProvider('test-server', 'http://example.com/mcp');
    expect(provider).toBeDefined();
  });

  it('reports no tokens for an unknown server', async () => {
    const svc = ix.get(IMcpOAuthService);
    const hasTokens = await svc.hasTokens('unknown', 'http://example.com/mcp');
    expect(hasTokens).toBe(false);
  });

  it('cancelAuthorization for unknown flow is a no-op', async () => {
    const svc = ix.get(IMcpOAuthService);
    await expect(svc.cancelAuthorization('nonexistent-flow')).resolves.toBeUndefined();
  });

  it('completeAuthorization for unknown flow throws', async () => {
    const svc = ix.get(IMcpOAuthService);
    await expect(svc.completeAuthorization('nonexistent-flow')).rejects.toThrow(
      'not found',
    );
  });

  it('caches providers for the same server/resource', () => {
    const svc = ix.get(IMcpOAuthService);
    const a = svc.getProvider('srv', 'http://example.com/mcp');
    const b = svc.getProvider('srv', 'http://example.com/mcp');
    expect(a).toBe(b);
  });

  it('different servers get different providers', () => {
    const svc = ix.get(IMcpOAuthService);
    const a = svc.getProvider('srv-a', 'http://example.com/a');
    const b = svc.getProvider('srv-b', 'http://example.com/b');
    expect(a).not.toBe(b);
  });
});
