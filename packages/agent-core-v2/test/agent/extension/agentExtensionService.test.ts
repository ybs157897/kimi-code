/**
 * `agentExtension` domain — main-Agent runtime activation scenarios.
 *
 * Resolves the service by interface with real event and tool registries while
 * controlling the Session catalog and execution hooks. Covers tools, commands,
 * turn/tool events, notices, vetoes, reload replacement, shutdown, and
 * subagent gating.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import type {
  ExtensionCommand,
  ExtensionEventName,
  ExtensionHandler,
  ExtensionTool,
  LoadedExtension,
} from '#/app/extension/extension.types';
import { IAgentExtensionService } from '#/agent/extension/agentExtension';
import { AgentExtensionService } from '#/agent/extension/agentExtensionService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { BeforeToolExecuteEmitter } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { OrderedHookSlot } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  type ExtensionReloadSummary,
  ISessionExtensionService,
} from '#/session/extension/sessionExtension';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';

function extension(input: {
  readonly id?: string;
  readonly handlers?: Map<ExtensionEventName, ExtensionHandler[]>;
  readonly tools?: readonly ExtensionTool[];
  readonly commands?: readonly ExtensionCommand[];
} = {}): LoadedExtension {
  const id = input.id ?? 'example';
  return {
    id,
    path: `/extensions/${id}.ts`,
    resolvedPath: `/extensions/${id}.ts`,
    handlers: input.handlers ?? new Map(),
    tools: new Map((input.tools ?? []).map((tool) => [tool.name, tool])),
    commands: new Map((input.commands ?? []).map((command) => [command.name, command])),
  };
}

function toolCall(id: string, name: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

describe('AgentExtensionService', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  function createRuntime(
    initial: readonly LoadedExtension[],
    agentId = 'main',
  ): {
    readonly ix: TestInstantiationService;
    readonly before: BeforeToolExecuteEmitter;
    readonly did: OrderedHookSlot<ToolDidExecuteContext>;
    readonly enqueue: ReturnType<typeof vi.fn>;
    activeToolNames(): readonly string[];
    bindProfileTools(toolNames: readonly string[]): void;
    reloadExtensions(extensions: readonly LoadedExtension[]): Promise<ExtensionReloadSummary>;
  } {
    let current = initial;
    let next = initial;
    let activeToolNames: readonly string[] = [];
    const before = new BeforeToolExecuteEmitter();
    const did = new OrderedHookSlot<ToolDidExecuteContext>();
    const reload = new Emitter<ExtensionReloadSummary>();
    const reloadParticipants = new Set<Parameters<
      ISessionExtensionService['registerReloadParticipant']
    >[0]>();
    const enqueue = vi.fn(async () => ({}) as never);
    const sessionExtensions: ISessionExtensionService = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidReload: reload.event,
      list: () => current,
      errors: () => [],
      reload: async () => {
        const participants = [...reloadParticipants];
        for (const participant of participants) await participant.prepareForReload();
        current = next;
        for (const participant of participants) await participant.activateReloadedCatalog();
        const summary = { active: current.map((item) => item.path), errors: [] };
        reload.fire(summary);
        return summary;
      },
      registerReloadParticipant: (participant) => {
        reloadParticipants.add(participant);
        return {
          dispose: () => {
            reloadParticipants.delete(participant);
          },
        };
      },
      listCommands: async () =>
        current.flatMap((item) =>
          [...item.commands.values()].map((command) => ({
            extensionId: item.id,
            name: command.name,
            description: command.description,
          })),
        ),
      resolveCommand: (extensionId, name) => {
        const item = current.find((candidate) => candidate.id === extensionId);
        const command = item?.commands.get(name);
        return item === undefined || command === undefined
          ? undefined
          : { extensionId, extensionPath: item.path, command };
      },
    };
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.define(IEventBus, EventBusService);
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.defineInstance(ISessionExtensionService, sessionExtensions);
        reg.defineInstance(IAgentScopeContext, {
          _serviceBrand: undefined,
          agentId,
          scope: () => `agents/${agentId}`,
        });
        reg.defineInstance(ISessionContext, {
          _serviceBrand: undefined,
          sessionId: 'session',
          workspaceId: 'workspace',
          sessionDir: '/sessions/session',
          metaScope: 'sessions/session',
          cwd: '/workspace',
          scope: () => 'sessions/session',
        });
        reg.definePartialInstance(IAgentToolExecutorService, {
          onBeforeExecuteTool: before.event,
          hooks: { onDidExecuteTool: did },
        });
        reg.definePartialInstance(IAgentToolPolicyService, {
          isToolActive: () => true,
        });
        reg.definePartialInstance(IAgentPromptService, { enqueue });
        reg.definePartialInstance(IAgentProfileService, {
          data: () => ({ cwd: '/workspace', activeToolNames }) as never,
          setModel: async (model) => ({ model }),
          update: () => undefined,
          addActiveTool: (name) => {
            if (!activeToolNames.includes(name)) activeToolNames = [...activeToolNames, name];
          },
          removeActiveTool: (name) => {
            activeToolNames = activeToolNames.filter((candidate) => candidate !== name);
          },
        });
        reg.define(IAgentExtensionService, AgentExtensionService);
      },
    });
    return {
      ix,
      before,
      did,
      enqueue,
      activeToolNames: () => activeToolNames,
      bindProfileTools(toolNames) {
        activeToolNames = [...toolNames];
        ix.get(IEventBus).publish({ type: 'agent.status.updated' });
      },
      async reloadExtensions(extensions) {
        next = extensions;
        return sessionExtensions.reload();
      },
    };
  }

  it('runs contributed tools and commands and forwards turn and tool result events', async () => {
    const observed: string[] = [];
    const handlers = new Map<ExtensionEventName, ExtensionHandler[]>([
      [
        'turn_end',
        [
          (_event, context) => {
            observed.push('turn_end');
            context.notify('done');
          },
        ],
      ],
      [
        'tool_result',
        [
          (event) => {
            observed.push(`${event.type}:${event.type === 'tool_result' ? event.output : ''}`);
          },
        ],
      ],
    ]);
    const runtime = createRuntime([
      extension({
        handlers,
        tools: [
          {
            name: 'echo',
            description: 'echo',
            parameters: {},
            execute: ({ args }) => ({ output: String(args['message']) }),
          },
        ],
        commands: [
          {
            name: 'hello',
            description: 'hello',
            prompt: (args) => `hello ${args}`,
          },
        ],
      }),
    ]);
    const notices: string[] = [];
    runtime.ix.get(IEventBus).subscribe('extension.notice', (event) => {
      notices.push(event.message);
    });
    const service = runtime.ix.get(IAgentExtensionService);

    await service.activate();

    const tool = runtime.ix.get(IAgentToolRegistryService).resolve('echo');
    const execution = await tool?.resolveExecution({ message: 'value' });
    if (execution === undefined || !('execute' in execution)) throw new Error('tool not executable');
    await expect(
      execution.execute({
        turnId: 7,
        toolCallId: 'call-echo',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ output: 'value', isError: false });

    runtime.ix.get(IEventBus).publish({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
    });
    const call = toolCall('call-echo', 'echo');
    await runtime.did.run({
      turnId: 7,
      signal: new AbortController().signal,
      toolCall: call,
      toolCalls: [call],
      tool,
      args: { message: 'value' },
      result: { output: 'value' },
    });
    await expect(
      service.activateCommand({ extensionId: 'example', name: 'hello', args: 'world' }),
    ).resolves.toBe(true);

    expect(notices).toEqual(['done']);
    expect(observed).toEqual(['turn_end', 'tool_result:value']);
    expect(runtime.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: 'text', text: 'hello world' }],
        }),
      }),
    );
  });

  it('vetoes calls blocked by an extension handler', async () => {
    const runtime = createRuntime([
      extension({
        handlers: new Map([
          [
            'tool_call',
            [
              () => ({
                block: true,
                reason: 'denied',
              }),
            ],
          ],
        ]),
        tools: [
          {
            name: 'old-tool',
            description: 'old',
            parameters: {},
            execute: () => ({ output: 'old' }),
          },
        ],
      }),
    ]);
    await runtime.ix.get(IAgentExtensionService).activate();
    const call = toolCall('call-old', 'old-tool');

    const decision = await runtime.before.fireBeforeExecute({
      turnId: 1,
      signal: new AbortController().signal,
      toolCall: call,
      toolCalls: [call],
      args: {},
      execution: {
        approvalRule: 'old-tool',
        execute: async () => ({ output: 'should not run' }),
      },
    });

    expect(decision).toEqual({ veto: { output: 'denied', isError: true } });
  });

  it('orders catalog start, reload, and shutdown while replacing contributed tools', async () => {
    const order: string[] = [];
    const lifecycleHandlers = (id: string) =>
      new Map<ExtensionEventName, ExtensionHandler[]>([
        ['session_start', [() => order.push(`${id}:start`)]],
        ['session_shutdown', [() => order.push(`${id}:shutdown`)]],
      ]);
    const runtime = createRuntime([
      extension({
        id: 'old',
        handlers: lifecycleHandlers('old'),
        tools: [
          {
            name: 'old-tool',
            description: 'old',
            parameters: {},
            execute: () => ({ output: 'old' }),
          },
        ],
      }),
    ]);
    const service = runtime.ix.get(IAgentExtensionService);
    await service.activate();

    await runtime.reloadExtensions([
      extension({
        id: 'new',
        handlers: lifecycleHandlers('new'),
        tools: [
          {
            name: 'new-tool',
            description: 'new',
            parameters: {},
            execute: () => ({ output: 'new' }),
          },
        ],
      }),
    ]);

    const registry = runtime.ix.get(IAgentToolRegistryService);
    expect(registry.resolve('old-tool')).toBeUndefined();
    expect(registry.resolve('new-tool')).toBeDefined();

    await service.shutdown();

    expect(order).toEqual([
      'old:start',
      'old:shutdown',
      'new:start',
      'new:shutdown',
    ]);
    expect(registry.resolve('new-tool')).toBeUndefined();
  });

  it('restores contributed tools after the first profile binding replaces active tools', async () => {
    const runtime = createRuntime([
      extension({
        tools: [
          {
            name: 'extension-tool',
            description: 'extension',
            parameters: {},
            execute: () => ({ output: 'extension' }),
          },
        ],
      }),
    ]);
    await runtime.ix.get(IAgentExtensionService).activate();

    runtime.bindProfileTools(['builtin-tool']);

    expect(runtime.activeToolNames()).toEqual(['builtin-tool', 'extension-tool']);
  });

  it('does not activate extensions for a subagent', async () => {
    const runtime = createRuntime([
      extension({
        tools: [
          {
            name: 'main-only',
            description: 'main only',
            parameters: {},
            execute: () => ({ output: 'main' }),
          },
        ],
      }),
    ], 'agent-1');
    const service = runtime.ix.get(IAgentExtensionService);

    await service.activate();

    expect(runtime.ix.get(IAgentToolRegistryService).resolve('main-only')).toBeUndefined();
    await expect(
      service.activateCommand({ extensionId: 'example', name: 'missing' }),
    ).resolves.toBe(false);
  });

  it('drains an in-flight turn end handler before session shutdown', async () => {
    const order: string[] = [];
    let release!: () => void;
    const handlerSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createRuntime([
      extension({
        handlers: new Map([
          [
            'turn_end',
            [
              async () => {
                order.push('turn_end:start');
                await handlerSettled;
                order.push('turn_end:end');
              },
            ],
          ],
          ['session_shutdown', [() => order.push('session_shutdown')]],
        ]),
      }),
    ]);
    const service = runtime.ix.get(IAgentExtensionService);
    await service.activate();
    runtime.ix.get(IEventBus).publish({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
    });
    await vi.waitFor(() => {
      expect(order).toEqual(['turn_end:start']);
    });

    let completed = false;
    const shutdown = service.shutdown().then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);
    expect(order).toEqual(['turn_end:start']);
    release();
    await shutdown;
    expect(order).toEqual(['turn_end:start', 'turn_end:end', 'session_shutdown']);
  });

  it('keeps shutdown pending until asynchronous session shutdown handlers settle', async () => {
    let release!: () => void;
    const handlerSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shutdownHandler = vi.fn(async () => {
      await handlerSettled;
    });
    const runtime = createRuntime([
      extension({
        handlers: new Map([['session_shutdown', [shutdownHandler]]]),
      }),
    ]);
    const service = runtime.ix.get(IAgentExtensionService);
    await service.activate();

    let completed = false;
    const shutdown = service.shutdown().then(() => {
      completed = true;
    });
    await vi.waitFor(() => {
      expect(shutdownHandler).toHaveBeenCalledOnce();
    });

    expect(completed).toBe(false);
    release();
    await shutdown;
    expect(completed).toBe(true);
  });

  it('returns one shutdown operation when shutdown is requested repeatedly', async () => {
    const shutdownHandler = vi.fn();
    const runtime = createRuntime([
      extension({
        handlers: new Map([['session_shutdown', [shutdownHandler]]]),
      }),
    ]);
    const service = runtime.ix.get(IAgentExtensionService);
    await service.activate();

    const first = service.shutdown();
    const second = service.shutdown();

    expect(second).toBe(first);
    await first;
    await service.shutdown();
    expect(shutdownHandler).toHaveBeenCalledOnce();
  });
});
