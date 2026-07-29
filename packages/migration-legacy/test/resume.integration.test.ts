/**
 * Filesystem-level verification that a migrated session lands in the expected
 * directory structure. The migrator writes session buckets named by
 * `computeWorkdirBucket`; v2's workspace resolver uses `encodeWorkDirKey(workDir)`
 * to locate sessions. If the two bucket algorithms diverge (see review item C1),
 * migrated sessions become silently invisible — these tests fail fast in that case.
 *
 * Unlike the original version, this test no longer drives a live `Session.resume()`
 * from the legacy `@moonshot-ai/agent-core`. It verifies the migration output at
 * the filesystem level instead, which is sufficient to catch bucket drift and
 * wire-format regressions.
 *
 * v2 API used:
 *   - `encodeWorkDirKey` from `@moonshot-ai/agent-core-v2/_base/utils/workdir-slug`
 *     (same function as `computeWorkdirBucket`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';

import { migrateOneSession, type MigrateOneResult } from '../src/sessions/migrate-one.js';
import { computeWorkdirBucket } from '../src/sessions/workdir-bucket.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const WORK_DIR = '/Users/example/proj';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'resume-integ-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

describe('migrated session lands in the correct bucket', () => {
  it('computeWorkdirBucket matches v2 encodeWorkDirKey', () => {
    expect(computeWorkdirBucket(WORK_DIR)).toBe(encodeWorkDirKey(WORK_DIR));
  });

  it('session directory exists under the expected workdir bucket', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'with-tool-calls'),
      oldSessionUuid: 'integ-uuid',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');

    // v2 lists sessions by reading the bucket directory: sessions/<bucket>/<id>/
    const bucket = computeWorkdirBucket(WORK_DIR);
    const bucketDir = join(targetHome, 'sessions', bucket);

    const entries = await readdir(bucketDir);
    expect(entries).toContain('ses_integ-uuid');

    // Read state.json from the migrated session to verify metadata.
    const stateRaw = await readFile(join(bucketDir, 'ses_integ-uuid', 'state.json'), 'utf-8');
    const state = JSON.parse(stateRaw) as Record<string, unknown>;
    expect(state['title']).toBe('run echo hi');
    expect(state['isCustomTitle']).toBe(true);
    const custom = state['custom'] as Record<string, unknown> | undefined;
    expect(custom?.['imported_from_kimi_cli']).toBe(true);
  });

  it('migrated wire history is non-empty', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const events = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]?.type).toBe('metadata');
    expect(events.filter((e) => e.type === 'context.append_message').length).toBeGreaterThan(0);
  });

  it('state.json references the correct agent main homedir', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    // Read state.json to verify it points at the correct agent subdirectory.
    const stateRaw = await readFile(join(targetDir, 'state.json'), 'utf-8');
    const state = JSON.parse(stateRaw) as Record<string, unknown>;

    // The state must reference "agents.main.homedir" pointing to
    // `<sessionDir>/agents/main` where the migrator writes the translated wire.
    const agents = (state as Record<string, unknown>)['agents'] as Record<string, unknown> | undefined;
    const mainAgent = agents?.['main'] as Record<string, unknown> | undefined;
    expect(mainAgent?.['homedir']).toBe(join(targetDir, 'agents', 'main'));

    // Verify the agent wire.jsonl exists and is non-empty.
    const agentDir = mainAgent?.['homedir'] as string;
    const wireStat = await stat(join(agentDir, 'wire.jsonl'));
    expect(wireStat.size).toBeGreaterThan(0);

    // Read the first events to confirm expected content.
    const wire = await readFile(join(agentDir, 'wire.jsonl'), 'utf-8');
    const events = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const contextAppends = events.filter((e) => e['type'] === 'context.append_message');
    expect(contextAppends.length).toBeGreaterThan(0);

    // The wire stores message content at `e.message.content`.
    const texts = contextAppends
      .flatMap((e) => {
        const msg = e['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'];
        return Array.isArray(content)
          ? content.map((c: Record<string, unknown>) => (typeof c['text'] === 'string' ? c['text'] : ''))
          : [];
      })
      .filter(Boolean);
    expect(texts.some((t: string) => t.toLowerCase().includes('hi'))).toBe(true);
    expect(texts.some((t: string) => t.toLowerCase().includes('hello'))).toBe(true);
  });

  it('wire.jsonl preserves a legacy todo display', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'large-100msgs'),
      oldSessionUuid: 'todo-display',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    // Read the agent wire and find the todo display for the known tool call id.
    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const events = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Find the context.append_message that carries the known tool call id,
    // then check its toolCallDisplays for the expected todo_list.
    // NormalizedMessage serializes as camelCase: `toolCalls`, not `tool_calls`.
    const todoEvent = events.find((e) => {
      if (e['type'] !== 'context.append_message') return false;
      const msg = e['message'] as Record<string, unknown> | undefined;
      const toolCalls = msg?.['toolCalls'];
      return Array.isArray(toolCalls) && toolCalls.some(
        (tc: Record<string, unknown>) => tc['id'] === 'tool_y3SXWWQIUysddnYoklaWhUeE',
      );
    });
    expect(todoEvent).toBeDefined();

    const msg = todoEvent!['message'] as Record<string, unknown> | undefined;
    const displays = msg?.['toolCallDisplays'] as Record<string, unknown> | undefined;
    expect(displays?.['tool_y3SXWWQIUysddnYoklaWhUeE']).toEqual({
      kind: 'todo_list',
      items: expect.arrayContaining([
        { title: '准备测试环境（创建隔离 work-dir）', status: 'in_progress' },
        { title: '汇报结论', status: 'pending' },
      ]),
    });
  });
});
