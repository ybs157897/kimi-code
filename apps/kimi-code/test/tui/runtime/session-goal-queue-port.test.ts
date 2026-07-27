/**
 * Scenario: upcoming-goal persistence crosses the active-session TUI runtime boundary.
 * Responsibilities: both adapters preserve parameters, errors, queue order, and copied
 * neutral snapshots without promoting a queued goal. Each runtime queue surface is stubbed.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-goal-queue-port.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  updateGoalQueueItem,
} from '#/tui/goal-queue-store';
import { createKlientSessionGoalQueuePort } from '#/tui/runtime/klient-session-goal-queue-adapter';
import { createLegacySessionGoalQueuePort } from '#/tui/runtime/legacy-session-goal-queue-adapter';
import type {
  GoalQueueMoveDirection,
  GoalQueueSnapshot,
  UpcomingGoal,
} from '#/tui/runtime/session-goal-queue-port';

vi.mock('#/tui/goal-queue-store', () => ({
  appendGoalQueueItem: vi.fn(),
  moveGoalQueueItem: vi.fn(),
  readGoalQueue: vi.fn(),
  removeGoalQueueItem: vi.fn(),
  restoreGoalQueueItem: vi.fn(),
  updateGoalQueueItem: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe('legacy session goal queue adapter', () => {
  it('read projects a copied snapshot from the bound legacy session', async () => {
    const goal = queuedGoal('queued-1', 'Draft docs');
    const goals = [goal];
    vi.mocked(readGoalQueue).mockResolvedValue({ goals });
    const session = legacySession();

    const result = await createLegacySessionGoalQueuePort(session).read();

    expect(readGoalQueue).toHaveBeenCalledWith(session);
    expect(result).toEqual({
      goals: [
        {
          id: 'queued-1',
          objective: 'Draft docs',
          createdAt: '2026-07-27T08:00:00.000Z',
          updatedAt: '2026-07-27T08:00:00.000Z',
        },
      ],
    });
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('append projects a copied snapshot for the forwarded legacy objective', async () => {
    const goal = queuedGoal('queued-1', 'Draft docs');
    const goals = [goal];
    vi.mocked(appendGoalQueueItem).mockResolvedValue({ goals });
    const session = legacySession();

    const result = await createLegacySessionGoalQueuePort(session).append({
      objective: 'Draft docs',
    });

    expect(appendGoalQueueItem).toHaveBeenCalledWith(session, {
      objective: 'Draft docs',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-1',
        objective: 'Draft docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('update projects a copied snapshot for the forwarded legacy patch', async () => {
    const goal = queuedGoal('queued-1', 'Publish docs');
    const goals = [goal];
    vi.mocked(updateGoalQueueItem).mockResolvedValue({ goals });
    const session = legacySession();

    const result = await createLegacySessionGoalQueuePort(session).update({
      goalId: 'queued-1',
      objective: 'Publish docs',
    });

    expect(updateGoalQueueItem).toHaveBeenCalledWith(session, {
      goalId: 'queued-1',
      objective: 'Publish docs',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-1',
        objective: 'Publish docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('remove projects a copied snapshot for the forwarded legacy goal ID', async () => {
    const remaining = queuedGoal('queued-2', 'Publish docs');
    const goals = [remaining];
    vi.mocked(removeGoalQueueItem).mockResolvedValue({ goals });
    const session = legacySession();

    const result = await createLegacySessionGoalQueuePort(session).remove({
      goalId: 'queued-1',
    });

    expect(removeGoalQueueItem).toHaveBeenCalledWith(session, {
      goalId: 'queued-1',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-2',
        objective: 'Publish docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(remaining);
  });

  it('restore preserves the legacy queue order for the forwarded goal', async () => {
    const restored = queuedGoal('queued-1', 'Draft docs');
    const existing = queuedGoal('queued-2', 'Publish docs');
    const goals = [restored, existing];
    vi.mocked(restoreGoalQueueItem).mockResolvedValue({ goals });
    const session = legacySession();

    const result = await createLegacySessionGoalQueuePort(session).restore(
      restored,
    );

    expect(restoreGoalQueueItem).toHaveBeenCalledWith(session, {
      id: 'queued-1',
      objective: 'Draft docs',
      createdAt: '2026-07-27T08:00:00.000Z',
      updatedAt: '2026-07-27T08:00:00.000Z',
    });
    expect(result.goals.map((goal) => goal.id)).toEqual([
      'queued-1',
      'queued-2',
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(restored);
    expect(result.goals[1]).not.toBe(existing);
  });

  it('move projects a copied snapshot for the forwarded legacy direction', async () => {
    const goal = queuedGoal('queued-1', 'Draft docs');
    const goals = [goal];
    vi.mocked(moveGoalQueueItem).mockResolvedValue({ goals });
    const session = legacySession();

    const result = await createLegacySessionGoalQueuePort(session).move({
      goalId: 'queued-1',
      direction: 'down',
    });

    expect(moveGoalQueueItem).toHaveBeenCalledWith(session, {
      goalId: 'queued-1',
      direction: 'down',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-1',
        objective: 'Draft docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('read preserves a legacy queue failure', async () => {
    const failure = new Error('Legacy goal queue unavailable.');
    vi.mocked(readGoalQueue).mockRejectedValue(failure);

    const result = createLegacySessionGoalQueuePort(legacySession()).read();

    await expect(result).rejects.toBe(failure);
  });
});

describe('Klient session goal queue adapter', () => {
  it('read projects a copied snapshot from the Klient session facade', async () => {
    const goal = queuedGoal('queued-1', 'Draft docs');
    const goals = [goal];
    const rig = klientSession({
      read: vi.fn(async () => ({ goals })),
    });

    const result = await createKlientSessionGoalQueuePort(rig.session).read();

    expect(rig.goalQueue.read).toHaveBeenCalledOnce();
    expect(result).toEqual({
      goals: [
        {
          id: 'queued-1',
          objective: 'Draft docs',
          createdAt: '2026-07-27T08:00:00.000Z',
          updatedAt: '2026-07-27T08:00:00.000Z',
        },
      ],
    });
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('append projects a copied snapshot for the forwarded Klient objective', async () => {
    const goal = queuedGoal('queued-1', 'Draft docs');
    const goals = [goal];
    const rig = klientSession({
      append: vi.fn(async () => ({ goals })),
    });

    const result = await createKlientSessionGoalQueuePort(
      rig.session,
    ).append({ objective: 'Draft docs' });

    expect(rig.goalQueue.append).toHaveBeenCalledWith({
      objective: 'Draft docs',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-1',
        objective: 'Draft docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('update projects a copied snapshot for the forwarded Klient patch', async () => {
    const goal = queuedGoal('queued-1', 'Publish docs');
    const goals = [goal];
    const rig = klientSession({
      update: vi.fn(async () => ({ goals })),
    });

    const result = await createKlientSessionGoalQueuePort(
      rig.session,
    ).update({
      goalId: 'queued-1',
      objective: 'Publish docs',
    });

    expect(rig.goalQueue.update).toHaveBeenCalledWith({
      goalId: 'queued-1',
      objective: 'Publish docs',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-1',
        objective: 'Publish docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('remove projects a copied snapshot for the forwarded Klient goal ID', async () => {
    const remaining = queuedGoal('queued-2', 'Publish docs');
    const goals = [remaining];
    const rig = klientSession({
      remove: vi.fn(async () => ({ goals })),
    });

    const result = await createKlientSessionGoalQueuePort(
      rig.session,
    ).remove({ goalId: 'queued-1' });

    expect(rig.goalQueue.remove).toHaveBeenCalledWith({
      goalId: 'queued-1',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-2',
        objective: 'Publish docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(remaining);
  });

  it('restore preserves the Klient queue order for the forwarded goal', async () => {
    const restored = queuedGoal('queued-1', 'Draft docs');
    const existing = queuedGoal('queued-2', 'Publish docs');
    const goals = [restored, existing];
    const rig = klientSession({
      restore: vi.fn(async () => ({ goals })),
    });

    const result = await createKlientSessionGoalQueuePort(
      rig.session,
    ).restore(restored);

    expect(rig.goalQueue.restore).toHaveBeenCalledWith({
      id: 'queued-1',
      objective: 'Draft docs',
      createdAt: '2026-07-27T08:00:00.000Z',
      updatedAt: '2026-07-27T08:00:00.000Z',
    });
    expect(result.goals.map((goal) => goal.id)).toEqual([
      'queued-1',
      'queued-2',
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(restored);
    expect(result.goals[1]).not.toBe(existing);
  });

  it('move projects a copied snapshot for the forwarded Klient direction', async () => {
    const goal = queuedGoal('queued-1', 'Draft docs');
    const goals = [goal];
    const rig = klientSession({
      move: vi.fn(async () => ({ goals })),
    });

    const result = await createKlientSessionGoalQueuePort(
      rig.session,
    ).move({ goalId: 'queued-1', direction: 'down' });

    expect(rig.goalQueue.move).toHaveBeenCalledWith({
      goalId: 'queued-1',
      direction: 'down',
    });
    expect(result.goals).toEqual([
      {
        id: 'queued-1',
        objective: 'Draft docs',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ]);
    expect(result.goals).not.toBe(goals);
    expect(result.goals[0]).not.toBe(goal);
  });

  it('read preserves a Klient queue failure', async () => {
    const failure = new Error('Klient goal queue unavailable.');
    const rig = klientSession({
      read: vi.fn(async () => {
        throw failure;
      }),
    });

    const result = createKlientSessionGoalQueuePort(rig.session).read();

    await expect(result).rejects.toBe(failure);
  });
});

function queuedGoal(id: string, objective: string): UpcomingGoal {
  return {
    id,
    objective,
    createdAt: '2026-07-27T08:00:00.000Z',
    updatedAt: '2026-07-27T08:00:00.000Z',
  };
}

function emptySnapshot(): GoalQueueSnapshot {
  return { goals: [] };
}

function legacySession() {
  return {
    id: 'session-legacy',
    summary: { sessionDir: '/workspace/session-legacy' },
  };
}

function klientSession(
  overrides: Partial<{
    read: () => Promise<GoalQueueSnapshot>;
    append: (input: {
      readonly objective: string;
    }) => Promise<GoalQueueSnapshot>;
    update: (input: {
      readonly goalId: string;
      readonly objective: string;
    }) => Promise<GoalQueueSnapshot>;
    remove: (input: {
      readonly goalId: string;
    }) => Promise<GoalQueueSnapshot>;
    restore: (goal: UpcomingGoal) => Promise<GoalQueueSnapshot>;
    move: (input: {
      readonly goalId: string;
      readonly direction: GoalQueueMoveDirection;
    }) => Promise<GoalQueueSnapshot>;
  }> = {},
) {
  const goalQueue = {
    read: overrides.read ?? vi.fn(async () => emptySnapshot()),
    append: overrides.append ?? vi.fn(async () => emptySnapshot()),
    update: overrides.update ?? vi.fn(async () => emptySnapshot()),
    remove: overrides.remove ?? vi.fn(async () => emptySnapshot()),
    restore: overrides.restore ?? vi.fn(async () => emptySnapshot()),
    move: overrides.move ?? vi.fn(async () => emptySnapshot()),
  };
  return {
    session: { goalQueue },
    goalQueue,
  };
}
