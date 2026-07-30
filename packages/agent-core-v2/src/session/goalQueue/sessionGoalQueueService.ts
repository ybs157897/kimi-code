/**
 * `goalQueue` domain (L4) — `ISessionGoalQueueService` implementation.
 *
 * Persists the v1-compatible `upcoming-goals.json` document through
 * `IAtomicDocumentStore`, addressed from the Session-scoped
 * `ISessionContext`. Mutations are serialized within the session.
 */

import { randomUUID } from 'node:crypto';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isNonEmptyString, isRecord } from '#/_base/utils/types';
import { Error2, ErrorCodes } from '#/errors';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  ISessionGoalQueueService,
  type GoalQueueSnapshot,
  type UpcomingGoal,
} from './sessionGoalQueue';

const GOAL_QUEUE_KEY = 'upcoming-goals.json';
const GOAL_QUEUE_VERSION = 1;
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

interface GoalQueueFile {
  readonly version: typeof GOAL_QUEUE_VERSION;
  readonly goals: readonly UpcomingGoal[];
}

export class SessionGoalQueueService implements ISessionGoalQueueService {
  declare readonly _serviceBrand: undefined;

  private readonly scope: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext context: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
  ) {
    this.scope = context.scope();
  }

  async read(): Promise<GoalQueueSnapshot> {
    return toSnapshot(await this.readQueueFile());
  }

  async append(input: { readonly objective: string }): Promise<GoalQueueSnapshot> {
    const objective = normalizeObjective(input.objective);
    return this.enqueueMutation(async () => {
      const state = await this.readQueueFile();
      const now = new Date().toISOString();
      const goal: UpcomingGoal = {
        id: randomUUID(),
        objective,
        createdAt: now,
        updatedAt: now,
      };
      return this.persist({ version: GOAL_QUEUE_VERSION, goals: [...state.goals, goal] });
    });
  }

  async update(input: {
    readonly goalId: string;
    readonly objective: string;
  }): Promise<GoalQueueSnapshot> {
    const objective = normalizeObjective(input.objective);
    return this.enqueueMutation(async () => {
      const state = await this.readQueueFile();
      const index = findGoalIndex(state, input.goalId);
      const current = state.goals[index]!;
      const updatedAt = timestampAfter(current.updatedAt);
      const goals = state.goals.map((goal, goalIndex) =>
        goalIndex === index ? { ...goal, objective, updatedAt } : goal,
      );
      return this.persist({ version: GOAL_QUEUE_VERSION, goals });
    });
  }

  async remove(input: { readonly goalId: string }): Promise<GoalQueueSnapshot> {
    return this.enqueueMutation(async () => {
      const state = await this.readQueueFile();
      const index = findGoalIndex(state, input.goalId);
      const goals = state.goals.filter((_, goalIndex) => goalIndex !== index);
      return this.persist({ version: GOAL_QUEUE_VERSION, goals });
    });
  }

  async restore(goal: UpcomingGoal): Promise<GoalQueueSnapshot> {
    return this.enqueueMutation(async () => {
      const state = await this.readQueueFile();
      if (state.goals.some((item) => item.id === goal.id)) {
        return toSnapshot(state);
      }
      return this.persist({
        version: GOAL_QUEUE_VERSION,
        goals: [goal, ...state.goals],
      });
    });
  }

  async move(input: {
    readonly goalId: string;
    readonly direction: 'up' | 'down';
  }): Promise<GoalQueueSnapshot> {
    return this.enqueueMutation(async () => {
      const state = await this.readQueueFile();
      const index = findGoalIndex(state, input.goalId);
      const targetIndex = input.direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= state.goals.length) {
        return toSnapshot(state);
      }
      const goals = [...state.goals];
      const [goal] = goals.splice(index, 1);
      goals.splice(targetIndex, 0, goal!);
      return this.persist({ version: GOAL_QUEUE_VERSION, goals });
    });
  }

  private async readQueueFile(): Promise<GoalQueueFile> {
    const value = await this.store.get<unknown>(this.scope, GOAL_QUEUE_KEY);
    if (value === undefined) return emptyQueueFile();
    if (isGoalQueueFile(value)) return value;
    throw new StorageError(
      StorageErrors.codes.STORAGE_CORRUPTED,
      'Upcoming goal queue document is malformed',
      { details: { scope: this.scope, key: GOAL_QUEUE_KEY } },
    );
  }

  private async persist(file: GoalQueueFile): Promise<GoalQueueSnapshot> {
    await this.store.set(this.scope, GOAL_QUEUE_KEY, file);
    return toSnapshot(file);
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(work, work);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function emptyQueueFile(): GoalQueueFile {
  return { version: GOAL_QUEUE_VERSION, goals: [] };
}

function toSnapshot(file: GoalQueueFile): GoalQueueSnapshot {
  return { goals: file.goals };
}

function normalizeObjective(value: string): string {
  const objective = value.trim();
  if (objective.length === 0) {
    throw new Error2(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    throw new Error2(
      ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
      `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
    );
  }
  return objective;
}

function findGoalIndex(file: GoalQueueFile, goalId: string): number {
  const index = file.goals.findIndex((goal) => goal.id === goalId);
  if (index === -1) {
    throw new Error2(ErrorCodes.GOAL_NOT_FOUND, 'No queued goal found');
  }
  return index;
}

function isGoalQueueFile(value: unknown): value is GoalQueueFile {
  if (!isRecord(value)) return false;
  return (
    value['version'] === GOAL_QUEUE_VERSION &&
    Array.isArray(value['goals']) &&
    value['goals'].every(isUpcomingGoal)
  );
}

function isUpcomingGoal(value: unknown): value is UpcomingGoal {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['objective']) &&
    isNonEmptyString(value['createdAt']) &&
    isNonEmptyString(value['updatedAt'])
  );
}

function timestampAfter(previous: string): string {
  const now = new Date();
  const previousMs = Date.parse(previous);
  if (Number.isFinite(previousMs) && now.getTime() <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return now.toISOString();
}

registerScopedService(
  LifecycleScope.Session,
  ISessionGoalQueueService,
  SessionGoalQueueService,
  ScopeActivation.OnDemand,
  'goalQueue',
);
