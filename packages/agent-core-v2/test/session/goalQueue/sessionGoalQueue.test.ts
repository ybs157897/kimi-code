/**
 * Scenario: A Session-scoped upcoming-goal queue is mutated and reconstructed from durable state.
 * Responsibility: The service owns validation, ordering, mutation serialization, and v1 file compatibility.
 * Wiring: The SUT is resolved from scoped DI over the real JSON document store and in-memory byte storage.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/session/goalQueue/sessionGoalQueue.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { ErrorCodes } from '#/errors';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  ISessionGoalQueueService,
  type UpcomingGoal,
} from '#/session/goalQueue/sessionGoalQueue';
import { SessionGoalQueueService } from '#/session/goalQueue/sessionGoalQueueService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

const SESSION_SCOPE = 'sessions/workspace-1/session-1';
const GOAL_QUEUE_KEY = 'upcoming-goals.json';

function makeGoal(id: string, objective: string): UpcomingGoal {
  return {
    id,
    objective,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SessionGoalQueueService', () => {
  let host: ScopedTestHost;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IFileSystemStorageService,
      InMemoryStorageService,
      ScopeActivation.OnDemand,
      'storage',
    );
    registerScopedService(
      LifecycleScope.App,
      IAtomicDocumentStore,
      JsonAtomicDocumentStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionGoalQueueService,
      SessionGoalQueueService,
      ScopeActivation.OnDemand,
      'goalQueue',
    );
    host = createScopedTestHost();
  });

  afterEach(() => {
    host.dispose();
  });

  function createQueue(childId: string): {
    readonly scope: Scope;
    readonly queue: ISessionGoalQueueService;
  } {
    const scope = host.child(LifecycleScope.Session, childId, [
      stubPair(
        ISessionContext,
        makeSessionContext({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          sessionDir: '/tmp/sessions/workspace-1/session-1',
          sessionScope: SESSION_SCOPE,
          cwd: '/tmp/workspace-1',
        }),
      ),
    ]);
    return { scope, queue: scope.accessor.get(ISessionGoalQueueService) };
  }

  it('returns an empty snapshot when the document is missing', async () => {
    const { queue } = createQueue('missing');

    await expect(queue.read()).resolves.toEqual({ goals: [] });
  });

  it('reads an existing v1 document', async () => {
    const goal = makeGoal('goal-1', 'existing objective');
    await host.app.accessor
      .get(IAtomicDocumentStore)
      .set(SESSION_SCOPE, GOAL_QUEUE_KEY, { version: 1, goals: [goal] });

    const { queue } = createQueue('v1');

    await expect(queue.read()).resolves.toEqual({ goals: [goal] });
  });

  it('appends a trimmed objective with stable creation timestamps', async () => {
    const { queue } = createQueue('append');

    const snapshot = await queue.append({ objective: '  investigate failure  ' });

    expect(snapshot.goals).toHaveLength(1);
    expect(snapshot.goals[0]).toMatchObject({
      objective: 'investigate failure',
    });
    expect(snapshot.goals[0]?.id).not.toBe('');
    expect(snapshot.goals[0]?.createdAt).toBe(snapshot.goals[0]?.updatedAt);
    expect(Date.parse(snapshot.goals[0]!.createdAt)).not.toBeNaN();
    await expect(
      host.app.accessor.get(IAtomicDocumentStore).get(SESSION_SCOPE, GOAL_QUEUE_KEY),
    ).resolves.toEqual({ version: 1, goals: snapshot.goals });
  });

  it('recovers persisted goals in a fresh Session-scoped instance', async () => {
    const first = createQueue('first');
    await first.queue.append({ objective: 'persist me' });
    first.scope.dispose();

    const second = createQueue('second');

    await expect(second.queue.read()).resolves.toMatchObject({
      goals: [{ objective: 'persist me' }],
    });
  });

  it('serializes concurrent appends without losing their order', async () => {
    const { queue } = createQueue('concurrent');
    const objectives = Array.from({ length: 12 }, (_, index) => `goal ${index}`);

    await Promise.all(objectives.map((objective) => queue.append({ objective })));

    expect((await queue.read()).goals.map((goal) => goal.objective)).toEqual(objectives);
  });

  it('updates the objective without changing queue position or creation time', async () => {
    const { queue } = createQueue('update');
    const first = (await queue.append({ objective: 'first' })).goals[0]!;
    const second = (await queue.append({ objective: 'second' })).goals[1]!;

    const snapshot = await queue.update({
      goalId: first.id,
      objective: '  changed  ',
    });

    expect(snapshot.goals.map((goal) => goal.id)).toEqual([first.id, second.id]);
    expect(snapshot.goals[0]).toMatchObject({
      objective: 'changed',
      createdAt: first.createdAt,
    });
    expect(Date.parse(snapshot.goals[0]!.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });

  it('removes the requested goal', async () => {
    const { queue } = createQueue('remove');
    const first = (await queue.append({ objective: 'first' })).goals[0]!;
    const second = (await queue.append({ objective: 'second' })).goals[1]!;

    const snapshot = await queue.remove({ goalId: first.id });

    expect(snapshot.goals).toEqual([second]);
  });

  it('restores a goal at the front of the queue', async () => {
    const { queue } = createQueue('restore');
    const existing = (await queue.append({ objective: 'existing' })).goals[0]!;
    const restored = makeGoal('restored', 'restored objective');

    const snapshot = await queue.restore(restored);

    expect(snapshot.goals).toEqual([restored, existing]);
  });

  it('does not duplicate a restored goal', async () => {
    const { queue } = createQueue('restore-duplicate');
    const existing = (await queue.append({ objective: 'existing' })).goals[0]!;

    const snapshot = await queue.restore(existing);

    expect(snapshot.goals).toEqual([existing]);
  });

  it('moves a goal up by one position', async () => {
    const { queue } = createQueue('move-up');
    const first = (await queue.append({ objective: 'first' })).goals[0]!;
    const second = (await queue.append({ objective: 'second' })).goals[1]!;

    const snapshot = await queue.move({ goalId: second.id, direction: 'up' });

    expect(snapshot.goals.map((goal) => goal.id)).toEqual([second.id, first.id]);
  });

  it('moves a goal down by one position', async () => {
    const { queue } = createQueue('move-down');
    const first = (await queue.append({ objective: 'first' })).goals[0]!;
    const second = (await queue.append({ objective: 'second' })).goals[1]!;

    const snapshot = await queue.move({ goalId: first.id, direction: 'down' });

    expect(snapshot.goals.map((goal) => goal.id)).toEqual([second.id, first.id]);
  });

  it('rejects an empty objective', async () => {
    const { queue } = createQueue('empty-objective');

    await expect(queue.append({ objective: '   ' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
  });

  it('rejects an objective longer than 4000 characters', async () => {
    const { queue } = createQueue('long-objective');

    await expect(queue.append({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('rejects mutation of an unknown goal', async () => {
    const { queue } = createQueue('not-found');

    await expect(queue.remove({ goalId: 'missing' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_NOT_FOUND,
    });
  });

  it('rejects a malformed document without overwriting it', async () => {
    const malformed = { version: 1, goals: [{ id: 'missing-fields' }] };
    const store = host.app.accessor.get(IAtomicDocumentStore);
    await store.set(SESSION_SCOPE, GOAL_QUEUE_KEY, malformed);
    const { queue } = createQueue('malformed');

    await expect(queue.read()).rejects.toMatchObject({ code: 'storage.corrupted' });
    await expect(store.get(SESSION_SCOPE, GOAL_QUEUE_KEY)).resolves.toEqual(malformed);
  });
});
