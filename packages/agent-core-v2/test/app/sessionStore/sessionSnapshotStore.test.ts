import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import {
  ISessionSnapshotStore,
} from '#/app/sessionStore/sessionSnapshotStore';
import { SessionSnapshotStoreService } from '#/app/sessionStore/sessionSnapshotStoreService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';

const WorkDir = '/home/user/repo';
const SourceSession = 'session_src';
const TargetSession = 'session_tgt';
const WorkspaceA = 'ws-a';
const AgentId = 'main';

function wireLogRecord(line: Record<string, unknown>): Record<string, unknown> {
  return line;
}

describe('SessionSnapshotStoreService', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionSnapshotStore,
      SessionSnapshotStoreService,
      ScopeActivation.OnDemand,
      'sessionStore',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ss-store-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): ISessionSnapshotStore {
    const fileStorage = new FileStorageService(homeDir);
    const appendLog = new AppendLogStore(fileStorage);
    const docs = new JsonAtomicDocumentStore(fileStorage);

    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IHostFileSystem, nodeHostFs()),
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAppendLogStore, appendLog),
      stubPair(IAtomicDocumentStore, docs),
      stubPair(IQueryStore, stubQueryStore()),
      stubPair(ISessionIndex, {
        _serviceBrand: undefined,
        list: async () => ({ items: [] }),
        get: async () => undefined,
        countActive: async () => 0,
      }),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    return host.app.accessor.get(ISessionSnapshotStore);
  }

  // ---- full fork ----

  it('full fork copies session files and agent wire', async () => {
    const svc = build();
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({ type: 'context.append_message', time: 2, message: { role: 'user', content: 'hello' } }),
    ]);
    await seedMeta(WorkspaceA, SourceSession, { title: 'original', createdAt: 1000, updatedAt: 2000, agents: { [AgentId]: {} } });

    const result = await svc.fork({
      sourceWorkspaceId: WorkspaceA,
      sourceSessionId: SourceSession,
      targetWorkspaceId: WorkspaceA,
      targetSessionId: TargetSession,
    });

    expect(result.agentIds).toEqual([AgentId]);
    expect(result.sourceMeta?.title).toBe('original');
    expect(result.cutoffTime).toBeUndefined();

    // Target wire should exist.
    const targetWire = await readWireLog(WorkspaceA, TargetSession, AgentId);
    expect(targetWire.length).toBeGreaterThanOrEqual(3); // metadata + message + forked
    expect(targetWire[targetWire.length - 1]!['type']).toBe('forked');
  });

  it('full fork returns agentIds empty when source has no agents dir', async () => {
    const svc = build();
    await seedSessionDir(WorkspaceA, SourceSession);
    await seedMeta(WorkspaceA, SourceSession, {});

    const result = await svc.fork({
      sourceWorkspaceId: WorkspaceA,
      sourceSessionId: SourceSession,
      targetWorkspaceId: WorkspaceA,
      targetSessionId: TargetSession,
    });

    expect(result.agentIds).toEqual([]);
  });

  // ---- fork with userVisibleTurnIndex ----

  it('indexed fork slices at turnIndex 0', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({ type: 'turn.prompt', time: 2, origin: { kind: 'user' }, input: 'hi' }),
      wireLogRecord({ type: 'context.append_message', time: 3, message: { role: 'user', content: 'hi' } }),
      wireLogRecord({ type: 'context.append_message', time: 4, message: { role: 'assistant', content: 'hey' } }),
      wireLogRecord({ type: 'turn.prompt', time: 5, origin: { kind: 'user' }, input: 'next' }),
      wireLogRecord({ type: 'context.append_message', time: 6, message: { role: 'user', content: 'next' } }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    const result = await svc.fork({
      sourceWorkspaceId: WorkspaceA,
      sourceSessionId: SourceSession,
      targetWorkspaceId: WorkspaceA,
      targetSessionId: TargetSession,
      userVisibleTurnIndex: 0,
    });

    const targetWire = await readWireLog(WorkspaceA, TargetSession, AgentId);
    // Should include metadata, turn.prompt, first user message, first assistant message, and forked.
    // The second turn's records should be excluded.
    const types = targetWire.map((r) => r['type']);
    expect(types).toContain('context.append_message');
    expect(types).not.toContain('next');
  });

  it('indexed fork with invalid turnIndex throws', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({ type: 'context.append_message', time: 2, message: { role: 'user', content: 'hi' } }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 5,
      }),
    ).rejects.toThrow(/Turn 5 was not found/);
  });

  it('indexed fork with negative turnIndex throws', async () => {
    const svc = build();
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
    ]);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: -1,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('indexed fork with empty wire log (only metadata) + turnIndex=0 throws', async () => {
    const svc = build();
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
    ]);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 0,
      }),
    ).rejects.toThrow(/Turn 0 was not found/);
  });

  it('indexed fork with NaN turnIndex throws', async () => {
    const svc = build();
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({ type: 'context.append_message', time: 2, message: { role: 'user', content: 'hi' } }),
    ]);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: NaN,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('indexed fork with Infinity turnIndex throws', async () => {
    const svc = build();
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({ type: 'context.append_message', time: 2, message: { role: 'user', content: 'hi' } }),
    ]);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: Infinity,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('indexed fork with all non-visible records (no user-visible turns) throws', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 2,
        origin: { kind: 'injection' },
        input: 'sys',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 3,
        message: { role: 'user', content: 'sys', origin: { kind: 'injection' } },
      }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 4,
        origin: { kind: 'background_task' },
        input: 'bg',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 5,
        message: { role: 'user', content: 'bg', origin: { kind: 'background_task' } },
      }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 6,
        origin: { kind: 'compaction_summary' },
        input: 'compacted',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 7,
        message: { role: 'user', content: 'compacted', origin: { kind: 'compaction_summary' } },
      }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 8,
        origin: { kind: 'cron_job' },
        input: 'cron',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 9,
        message: { role: 'user', content: 'cron', origin: { kind: 'cron_job' } },
      }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 0,
      }),
    ).rejects.toThrow(/Turn 0 was not found/);
  });

  // ---- visible-turn-index computation (legacy fixtures) ----

  it('counts user prompt as a user-visible turn', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({ type: 'turn.prompt', time: 2, origin: { kind: 'user' }, input: 'hi' }),
      wireLogRecord({ type: 'context.append_message', time: 3, message: { role: 'user', content: 'hi' } }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    const result = await svc.fork({
      sourceWorkspaceId: WorkspaceA,
      sourceSessionId: SourceSession,
      targetWorkspaceId: WorkspaceA,
      targetSessionId: TargetSession,
      userVisibleTurnIndex: 0,
    });
    expect(result.agentIds).toEqual([AgentId]);
  });

  it('user-slash skill_activation counts as user-visible', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 2,
        origin: { kind: 'skill_activation', trigger: 'user-slash' },
        input: '/skill',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 3,
        message: { role: 'user', content: '/skill', origin: { kind: 'skill_activation', trigger: 'user-slash' } },
      }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    // turnIndex 0 should work (the slash command IS visible).
    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('background_task origin is NOT a user-visible turn', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 2,
        origin: { kind: 'background_task' },
        input: 'bg',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 3,
        message: { role: 'user', content: 'bg', origin: { kind: 'background_task' } },
      }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    // There are no user-visible turns, so turnIndex 0 should throw.
    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 0,
      }),
    ).rejects.toThrow(/Turn 0 was not found/);
  });

  it('shell_command input phase counts as user-visible', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 2,
        origin: { kind: 'shell_command', phase: 'input' },
        input: 'ls',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 3,
        message: { role: 'user', content: 'ls', origin: { kind: 'shell_command', phase: 'input' } },
      }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('injection origin is NOT a user-visible turn', async () => {
    const svc = build();
    const records = [
      wireLogRecord({ type: 'metadata', created_at: 1, protocol_version: '1.0' }),
      wireLogRecord({
        type: 'turn.prompt',
        time: 2,
        origin: { kind: 'injection' },
        input: 'system msg',
      }),
      wireLogRecord({
        type: 'context.append_message',
        time: 3,
        message: { role: 'user', content: 'system msg', origin: { kind: 'injection' } },
      }),
    ];
    await seedSessionDir(WorkspaceA, SourceSession, AgentId, records);
    await seedMeta(WorkspaceA, SourceSession, {
      agents: { [AgentId]: {} },
    });

    await expect(
      svc.fork({
        sourceWorkspaceId: WorkspaceA,
        sourceSessionId: SourceSession,
        targetWorkspaceId: WorkspaceA,
        targetSessionId: TargetSession,
        userVisibleTurnIndex: 0,
      }),
    ).rejects.toThrow(/Turn 0 was not found/);
  });

  // ---- delete ----

  it('delete removes session directory', async () => {
    const svc = build();
    const sessionDir = join(homeDir, 'sessions', WorkspaceA, SourceSession);
    await fsp.mkdir(sessionDir, { recursive: true });

    await svc.delete({ workspaceId: WorkspaceA, sessionId: SourceSession });

    // Directory should be removed.
    await expect(fsp.access(sessionDir)).rejects.toThrow();
  });

  it('delete on non-existent session succeeds (idempotent)', async () => {
    const svc = build();
    await expect(
      svc.delete({ workspaceId: WorkspaceA, sessionId: 'nonexistent' }),
    ).resolves.toBeUndefined();
  });

  // ---- helpers ----

  async function seedSessionDir(
    workspaceId: string,
    sessionId: string,
    agentId?: string,
    wireRecords?: Record<string, unknown>[],
  ): Promise<void> {
    const sessionDir = join(homeDir, 'sessions', workspaceId, sessionId);
    if (agentId !== undefined && wireRecords !== undefined) {
      const agentDir = join(sessionDir, 'agents', agentId);
      await fsp.mkdir(agentDir, { recursive: true });
      const lines = wireRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await fsp.writeFile(join(agentDir, 'wire.jsonl'), lines);
    } else {
      await fsp.mkdir(sessionDir, { recursive: true });
    }
  }

  async function seedMeta(
    workspaceId: string,
    sessionId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const dir = join(homeDir, 'sessions', workspaceId, sessionId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  async function readWireLog(
    workspaceId: string,
    sessionId: string,
    agentId: string,
  ): Promise<Record<string, unknown>[]> {
    const path = join(homeDir, 'sessions', workspaceId, sessionId, 'agents', agentId, 'wire.jsonl');
    try {
      const content = await fsp.readFile(path, 'utf-8');
      return content
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
});

/**
 * Minimal real host filesystem backed by Node's fs, for integration-level
 * tests that need actual file I/O through `IHostFileSystem`.
 */
function nodeHostFs(): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    readText: async (path: string) => fsp.readFile(path, 'utf-8'),
    writeText: async (path: string, data: string) => fsp.writeFile(path, data),
    appendText: async (path: string, data: string) => fsp.appendFile(path, data),
    readBytes: async (path: string, n?: number) => {
      if (n === undefined) return fsp.readFile(path);
      const fd = await fsp.open(path, 'r');
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fd.read(buf, 0, n, 0);
        return new Uint8Array(buf.buffer, 0, bytesRead);
      } finally {
        await fd.close();
      }
    },
    writeBytes: async (path: string, data: Uint8Array) => fsp.writeFile(path, data),
    async *readLines(path: string) {
      const content = await fsp.readFile(path, 'utf-8');
      for (const line of content.split('\n')) yield line;
    },
    createExclusive: async (path: string, data: Uint8Array) => {
      try {
        const fd = await fsp.open(path, 'wx');
        try {
          await fd.write(data);
        } finally {
          await fd.close();
        }
        return true;
      } catch {
        return false;
      }
    },
    stat: async (path: string) => {
      const s = await fsp.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
    },
    lstat: async (path: string) => {
      const s = await fsp.lstat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
    },
    readdir: async (path: string) => {
      const entries = await fsp.readdir(path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    },
    mkdir: async (path: string, opts?: { recursive?: boolean }) => {
      await fsp.mkdir(path, { recursive: opts?.recursive });
    },
    remove: async (path: string) => fsp.rm(path, { recursive: true, force: true }),
    realpath: async (path: string) => fsp.realpath(path),
  };
}
