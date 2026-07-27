/**
 * Scenario: a consumer reads the complete Agent replay snapshot before and
 * after restoring the same wire history.
 * Responsibility: verify the Agent-scoped read projection is complete,
 * replay-stable, and observational.
 * Wiring: resolve `IAgentReplayView` from the test Agent DI scope; only the
 * process task is replaced at its external process boundary.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/replayView/replayView.test.ts
 */

import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { contextApplyCompaction } from '#/agent/contextMemory/contextOps';
import {
  fullCompactionBegin,
  fullCompactionComplete,
} from '#/agent/fullCompaction/compactionOps';
import { createGoal, updateGoal } from '#/agent/goal/goalOps';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentReplayView } from '#/agent/replayView/agentReplayView';
import { AgentReplayViewService } from '#/agent/replayView/agentReplayViewService';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IAgentTaskService } from '#/agent/task/task';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type { IProcess } from '#/session/process/processRunner';

import {
  agentServices,
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

const replayViewServices = agentServices((registration) => {
  registration.define(IAgentReplayView, AgentReplayViewService);
});

async function createPopulatedAgent(
  persistence: InMemoryWireRecordPersistence,
): Promise<TestAgentContext> {
  const ctx = createTestAgent(replayViewServices, { persistence });

  ctx.appendTurnExchange('Keep the first requirement', 'I will keep it');
  ctx.get(IAgentPermissionModeService).setMode('auto');
  ctx.get(IAgentPermissionRulesService).recordApprovalResult({
    turnId: 1,
    toolCallId: 'call-example',
    toolName: 'ExampleTool',
    action: 'run the example tool',
    sessionApprovalRule: 'ExampleTool(*)',
    result: { decision: 'approved', scope: 'session' },
  });
  await ctx.get(IAgentPlanService).enter('example-plan');
  ctx.get(IAgentSwarmService).enter('manual');
  ctx.get(IAgentUsageService).record('mock-model', {
    inputOther: 7,
    output: 3,
    inputCacheRead: 2,
    inputCacheCreation: 1,
  });
  ctx.get(IAgentUserToolService).register({
    name: 'ExampleTool',
    description: 'A neutral test tool',
    parameters: { type: 'object', properties: {} },
  });

  ctx.wire.dispatch(
    createGoal({
      goalId: 'goal-example',
      objective: 'Prove replay stability',
      wallClockResumedAt: 1,
      budgetLimits: { turnBudget: 2 },
    }),
  );
  ctx.wire.dispatch(
    updateGoal({
      goalId: 'goal-example',
      status: 'complete',
      reason: 'verified',
      turnsUsed: 1,
      tokensUsed: 10,
      wallClockMs: 20,
      actor: 'model',
    }),
  );
  ctx.wire.dispatch(
    fullCompactionBegin({
      source: 'manual',
      instruction: 'Retain only the durable requirement',
    }),
  );
  ctx.wire.dispatch(
    contextApplyCompaction({
      summary: 'The durable requirement remains.',
      contextSummary: 'The durable requirement remains.',
      compactedCount: 2,
      tokensBefore: 20,
      tokensAfter: 5,
      keptUserMessageCount: 1,
      keptHeadUserMessageCount: 0,
      droppedCount: 1,
    }),
  );
  ctx.wire.dispatch(fullCompactionComplete({}));

  const tasks = ctx.get(IAgentTaskService);
  const taskId = tasks.registerTask(
    new ProcessTask(completedProcess(), 'echo replay', 'Replay example task'),
  );
  await tasks.suppressTerminalNotification(taskId);
  await tasks.wait(taskId);
  await ctx.wire.flush();
  ctx.newEvents();
  return ctx;
}

function completedProcess(): IProcess {
  return {
    stdin: new PassThrough(),
    stdout: Readable.from(['complete']),
    stderr: Readable.from([]),
    pid: 42,
    exitCode: 0,
    wait: async () => 0,
    kill: async () => {},
    dispose: async () => {},
  };
}

describe('Agent replay view', () => {
  it('reads every populated replay snapshot slice', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = await createPopulatedAgent(persistence);
    try {
      const snapshot = await ctx.get(IAgentReplayView).read();

      expect(snapshot).toMatchObject({
        type: 'main',
        config: {
          modelAlias: 'mock-model',
          thinkingLevel: 'off',
        },
        permission: {
          mode: 'auto',
          rules: [],
        },
        plan: {
          id: 'example-plan',
          content: '',
        },
        swarmMode: true,
        usage: {
          total: {
            inputOther: 7,
            output: 3,
            inputCacheRead: 2,
            inputCacheCreation: 1,
          },
        },
      });
      expect(snapshot.context.history).not.toHaveLength(0);
      expect(snapshot.context.tokenCount).toBeGreaterThan(0);
      expect(snapshot.tools).toContainEqual(
        expect.objectContaining({ name: 'ExampleTool' }),
      );
      expect(snapshot.tasks).toContainEqual(
        expect.objectContaining({
          description: 'Replay example task',
          status: 'completed',
        }),
      );
      expect(snapshot.replay.map((record) => record.type)).toEqual(
        expect.arrayContaining([
          'message',
          'compaction',
          'goal_updated',
          'plan_updated',
          'config_updated',
          'permission_updated',
          'approval_result',
        ]),
      );
      expect(snapshot.replay).toContainEqual(
        expect.objectContaining({
          type: 'compaction',
          result: expect.objectContaining({
            contextSummary: 'The durable requirement remains.',
          }),
        }),
      );
    } finally {
      await ctx.dispose();
    }
  });

  it('returns the same snapshot after wire restore', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = await createPopulatedAgent(persistence);
    let restored: TestAgentContext | undefined;
    try {
      const liveSnapshot = await live.get(IAgentReplayView).read();
      restored = createTestAgent(replayViewServices, {
        autoConfigure: false,
        persistence: new InMemoryWireRecordPersistence(persistence.records),
      });

      await restored.restorePersisted();

      await expect(restored.get(IAgentReplayView).read()).resolves.toEqual(
        liveSnapshot,
      );
    } finally {
      await restored?.dispose();
      await live.dispose();
    }
  });

  it('does not write records or publish events while reading', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = await createPopulatedAgent(persistence);
    try {
      const beforeRecords = structuredClone(persistence.records);
      const first = await ctx.get(IAgentReplayView).read();
      const second = await ctx.get(IAgentReplayView).read();

      expect(second).toEqual(first);
      expect(persistence.records).toEqual(beforeRecords);
      expect(ctx.newEvents()).toHaveLength(0);
    } finally {
      await ctx.dispose();
    }
  });
});
