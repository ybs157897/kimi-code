import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, KimiError, type Event } from '#/index';

import { TEST_IDENTITY } from './test-identity';

// Minimal test-scoped SessionStore for rename tests.
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';

class TestSessionStore {
  constructor(readonly homeDir: string) {}

  async create(opts: { id: string; workDir: string }): Promise<{
    id: string; sessionDir: string; workDir: string;
  }> {
    const wdKey = encodeWorkDirKey(opts.workDir);
    const sessionDir = join(this.homeDir, 'sessions', wdKey, opts.id);
    await mkdir(sessionDir, { recursive: true });
    return { id: opts.id, sessionDir, workDir: opts.workDir };
  }

  async rename(id: string, newTitle: string): Promise<void> {
    const sessions = await this.listAll();
    const session = sessions.find(s => s.id === id);
    if (!session) {
      throw makeError(
        'session.not_found',
        `Session "${id}" does not exist`,
        { sessionId: id },
      );
    }
    const filePath = join(session.sessionDir, 'state.json');
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      throw makeError('session.state_not_found', `Session "${id}" has no state.json`);
    }
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw makeError('session.state_invalid', `State for "${id}" is not a valid object`);
    }
    if (Array.isArray(state)) {
      throw makeError('session.state_invalid', `State for "${id}" is not a valid object`);
    }
    state['title'] = newTitle;
    state['isCustomTitle'] = true;
    await writeFile(filePath, JSON.stringify(state) + '\n');
  }

  async get(id: string): Promise<{ id: string; sessionDir: string; workDir: string; title?: string; metadata?: Record<string, unknown> } | undefined> {
    const sessions = await this.listAll();
    return sessions.find(s => s.id === id);
  }

  private async listAll(): Promise<{ id: string; sessionDir: string; workDir: string; title?: string; metadata?: Record<string, unknown> }[]> {
    const base = join(this.homeDir, 'sessions');
    const results: { id: string; sessionDir: string; workDir: string; title?: string; metadata?: Record<string, unknown> }[] = [];
    try {
      const buckets = await readdir(base);
      for (const bucket of buckets) {
        const bucketDir = join(base, bucket);
        try {
          const ids = await readdir(bucketDir);
          for (const id of ids) {
            const sd = join(bucketDir, id);
            const state = await readSimpleState(sd);
            results.push({ id, sessionDir: sd, workDir: '', title: state?.['title'] as string | undefined, metadata: state?.['metadata'] as Record<string, unknown> | undefined });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return results;
  }
}

async function readSimpleState(sessionDir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as Record<string, unknown>;
  } catch { return undefined; }
}

function makeError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Error {
  const err = new Error(message) as Error & {
    code: string;
    details?: Record<string, unknown>;
  };
  err.name = 'KimiError';
  err.code = code;
  err.details = details;
  return err;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-rename-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSessionState(
  sessionDir: string,
  state: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(sessionDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

async function readSessionState(sessionDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function findRenamedEvent(
  events: readonly Event[],
): Extract<Event, { readonly type: 'session.meta.updated' }> {
  const event = events.find((item) => item.type === 'session.meta.updated');
  if (event === undefined || event.type !== 'session.meta.updated') {
    throw new Error('session_meta_updated event not found');
  }
  return event;
}

describe('SessionStore.rename', () => {
  it('persists custom title state and preserves existing state fields', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new TestSessionStore(homeDir);

    const summary = await store.create({
      id: 'ses_store_rename',
      workDir,
    });
    await writeSessionState(summary.sessionDir, {
      session_id: 'ses_store_rename',
      title: 'Original Title',
      updated_at: 1_000,
      model: 'kimi-for-coding',
      nested: { enabled: true },
    });

    await store.rename('ses_store_rename', 'New Store Title');

    const state = await readSessionState(summary.sessionDir);
    expect(state).toMatchObject({
      session_id: 'ses_store_rename',
      title: 'New Store Title',
      updated_at: 1_000,
      model: 'kimi-for-coding',
      isCustomTitle: true,
      nested: { enabled: true },
    });

    const renamed = await store.get('ses_store_rename');
    expect(renamed!.title).toBe('New Store Title');
    expect(renamed!.metadata).toBeUndefined();
  });

  it('rejects indexed sessions with missing state without creating state.json', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new TestSessionStore(homeDir);
    const summary = await store.create({ id: 'ses_no_state_rename', workDir });

    await expect(store.rename(summary.id, 'Missing State')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.state_not_found',
    } satisfies Partial<KimiError>);
    expect(existsSync(join(summary.sessionDir, 'state.json'))).toBe(false);
  });

  it('rejects invalid state.json without overwriting it', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new TestSessionStore(homeDir);
    const summary = await store.create({ id: 'ses_bad_state_rename', workDir });
    await writeFile(join(summary.sessionDir, 'state.json'), '[]', 'utf-8');

    await expect(store.rename(summary.id, 'Bad State')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.state_invalid',
    } satisfies Partial<KimiError>);
    expect(await readFile(join(summary.sessionDir, 'state.json'), 'utf-8')).toBe('[]');
  });

  it('rejects missing session ids without creating state', async () => {
    const homeDir = await makeTempDir();
    const store = new TestSessionStore(homeDir);

    await expect(store.rename('ses_missing', 'Missing Title')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.not_found',
      details: { sessionId: 'ses_missing' },
    } satisfies Partial<KimiError>);
    expect(existsSync(join(homeDir, 'sessions', 'ses_missing', 'state.json'))).toBe(false);
  });
});

describe('KimiHarness.renameSession', () => {
  it('persists titles through the public Harness API and emits an active session event', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_harness_rename',
        workDir,
      });
      const summary = (await harness.listSessions({ workDir })).find(
        (item) => item.id === session.id,
      )!;
      await writeSessionState(summary.sessionDir, {
        session_id: session.id,
        title: 'Base Title',
      });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await harness.renameSession({ id: session.id, title: 'Harness Title' });
      unsubscribe();

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.find((item) => item.id === session.id)?.title).toBe('Harness Title');

      const state = await readSessionState(summary.sessionDir);
      expect(state['title']).toBe('Harness Title');
      expect(state['isCustomTitle']).toBe(true);

      const event = findRenamedEvent(events);
      expect(event).toMatchObject({
        type: 'session.meta.updated',
        sessionId: session.id,
        agentId: 'main',
        title: 'Harness Title',
      });
    } finally {
      await harness.close();
    }
  });

  it('renames persisted sessions even when they are not active in memory', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_inactive_rename', workDir });
      const summary = (await harness.listSessions({ workDir })).find(
        (item) => item.id === session.id,
      )!;
      await writeSessionState(summary.sessionDir, {
        session_id: session.id,
        title: 'Inactive Base',
      });
      const events: Event[] = [];
      session.onEvent((event) => {
        events.push(event);
      });

      await harness.closeSession(session.id);
      events.length = 0;

      await harness.renameSession({ id: session.id, title: 'Inactive Title' });

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.find((item) => item.id === session.id)?.title).toBe('Inactive Title');
      expect(events.some((event) => event.type === 'session.meta.updated')).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('rejects missing session ids', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const missingRename = harness.renameSession({
        id: 'ses_missing',
        title: 'Missing Title',
      });
      await expect(missingRename).rejects.toBeInstanceOf(KimiError);
      await expect(missingRename).rejects.toMatchObject({
        code: 'session.not_found',
        details: { sessionId: 'ses_missing' },
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
