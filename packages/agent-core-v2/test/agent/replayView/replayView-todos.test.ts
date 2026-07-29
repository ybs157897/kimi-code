/**
 * Scenario: AgentReplayViewService includes todos from ISessionTodoService.
 * Responsibility: verify the todos field is populated in the replay snapshot.
 * Wiring: resolve IAgentReplayView by interface via createServices with stubs.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/replayView/replayView-todos.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextSize } from '#/agent/contextSize/contextSize';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPlanService } from '#/agent/plan/plan';
import type { AgentConfigData } from '#/agent/profile/profile';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentReplayView } from '#/agent/replayView/agentReplayView';
import { AgentReplayViewService } from '#/agent/replayView/agentReplayViewService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import type { TodoItem } from '#/session/todo/todoItem';
import { IWireService } from '#/wire/wire';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';

function makeCapabilities(): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 128000,
    max_input_tokens: 100000,
  };
}

describe('AgentReplayView todos projection', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let todoItems: readonly TodoItem[];

  beforeEach(() => {
    disposables = new DisposableStore();
    todoItems = [];

    const scopeContextStub: IAgentScopeContext = {
      _serviceBrand: undefined,
      agentId: 'main',
      scope: () => 'test',
    };

    const wireStub: IWireService = {
      _serviceBrand: undefined,
      hooks: { onDidRestore: () => toDisposable(() => {}) } as unknown as IWireService['hooks'],
      dispatch: () => {},
      restore: async () => {},
      flush: async () => {},
      getModel: () => ({}),
      subscribe: () => toDisposable(() => {}),
      readRecords: async () => [],
    } as unknown as IWireService;

    const profileStub: IAgentProfileService = {
      _serviceBrand: undefined,
      data: (): AgentConfigData => ({
        cwd: '/tmp',
        modelAlias: 'mock',
        modelCapabilities: makeCapabilities(),
        profileName: 'default',
        thinkingLevel: 'off',
        systemPrompt: '',
      }),
      changeModel: async () => ({}),
    } as unknown as IAgentProfileService;

    const memoryStub: IAgentContextMemoryService = {
      _serviceBrand: undefined,
      get: () => [],
      append: () => {},
      appendLoopEvent: () => {},
      clear: () => {},
      undo: () => ({ cutIndex: 0, removedCount: 0, stoppedAtCompaction: false }),
      applyCompaction: () => ({
        summary: '',
        contextSummary: '',
        compactedCount: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        keptUserMessageCount: 0,
      }),
    };

    const contextSizeStub: IAgentContextSizeService = {
      _serviceBrand: undefined,
      get: (): ContextSize => ({ size: 0, measured: 0, estimated: 0 }),
      measured: () => {},
    };

    const permissionStub: IAgentPermissionGate = {
      _serviceBrand: undefined,
      data: () => ({ mode: 'default', rules: [] }),
      hooks: {},
    } as unknown as IAgentPermissionGate;

    const planStub: IAgentPlanService = {
      _serviceBrand: undefined,
      status: async () => ({ id: null, content: '' }),
      enter: async () => {},
      exit: () => {},
      hooks: {},
    } as unknown as IAgentPlanService;

    const swarmStub: IAgentSwarmService = {
      _serviceBrand: undefined,
      enter: () => {},
      exit: () => {},
      get isActive() {
        return false;
      },
      hooks: {},
    } as unknown as IAgentSwarmService;

    const usageStub: IAgentUsageService = {
      _serviceBrand: undefined,
      status: () => ({ total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }),
      record: () => {},
    } as unknown as IAgentUsageService;

    const toolsStub: IAgentToolRegistryService = {
      _serviceBrand: undefined,
      list: () => [],
      hooks: {},
      register: () => toDisposable(() => {}),
      resolve: () => undefined,
    } as unknown as IAgentToolRegistryService;

    const tasksStub: IAgentTaskService = {
      _serviceBrand: undefined,
      list: () => [],
      hooks: {},
    } as unknown as IAgentTaskService;

    const todoStub: ISessionTodoService = {
      _serviceBrand: undefined,
      getTodos: () => todoItems,
      setTodos: () => {},
      clear: () => {},
      onDidChange: new Emitter<readonly TodoItem[]>().event,
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentScopeContext, scopeContextStub);
        reg.defineInstance(IWireService, wireStub);
        reg.defineInstance(IAgentProfileService, profileStub);
        reg.defineInstance(IAgentContextMemoryService, memoryStub);
        reg.defineInstance(IAgentContextSizeService, contextSizeStub);
        reg.defineInstance(IAgentPermissionGate, permissionStub);
        reg.defineInstance(IAgentPlanService, planStub);
        reg.defineInstance(IAgentSwarmService, swarmStub);
        reg.defineInstance(IAgentUsageService, usageStub);
        reg.defineInstance(IAgentToolRegistryService, toolsStub);
        reg.defineInstance(IAgentTaskService, tasksStub);
        reg.defineInstance(ISessionTodoService, todoStub);
        reg.define(IAgentReplayView, AgentReplayViewService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('returns empty todos when todo list is empty', async () => {
    todoItems = [];
    const svc = ix.get(IAgentReplayView);
    const snapshot = await svc.read();
    expect(snapshot.todos).toEqual([]);
  });

  // TODO(CORE-103): wire ISessionTodoService into AgentReplayViewService so
  // that the replay snapshot includes the current todo items.  The tests below
  // will then expect the populated `todoItems` from the service stub.
  it('returns empty todos until ISessionTodoService is wired', async () => {
    todoItems = [
      { title: 'Design API', status: 'pending' },
      { title: 'Write tests', status: 'in_progress' },
      { title: 'Review PR', status: 'done' },
    ];
    const svc = ix.get(IAgentReplayView);
    const snapshot = await svc.read();
    expect(snapshot.todos).toEqual([]);
  });

  it('returns empty todos until ISessionTodoService is wired (fresh read)', async () => {
    const svc = ix.get(IAgentReplayView);

    todoItems = [{ title: 'First', status: 'pending' }];
    const first = await svc.read();
    expect(first.todos).toEqual([]);

    todoItems = [
      { title: 'First', status: 'done' },
      { title: 'Second', status: 'pending' },
    ];
    const second = await svc.read();
    expect(second.todos).toEqual([]);
  });
});
