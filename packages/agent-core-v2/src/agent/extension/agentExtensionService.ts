/**
 * `agentExtension` domain (L4) — `IAgentExtensionService` implementation.
 *
 * Activates the Session extension catalog for the main Agent, registers
 * callback-backed tools through `toolRegistry`, maps turn facts from `event`
 * and tool interception through `toolExecutor`, and implements runtime actions
 * through `prompt`, `profile`, and `toolPolicy`. Bound at Agent scope.
 */

import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import type {
  ExtensionContext,
  ExtensionEvent,
  ExtensionEventInput,
  ExtensionTool,
  ToolCallEventResult,
} from '#/app/extension/extension.types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionExtensionService } from '#/session/extension/sessionExtension';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '#/tool/toolContract';

import {
  type ActivateExtensionCommandInput,
  IAgentExtensionService,
} from './agentExtension';

const MAIN_AGENT_ID = 'main';

export class AgentExtensionService extends Disposable implements IAgentExtensionService {
  declare readonly _serviceBrand: undefined;

  private readonly toolRegistrations = this._register(new DisposableStore());
  private readonly runtimeSubscriptions = this._register(new DisposableStore());
  private readonly registeredToolNames = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private catalogGeneration = 0;
  private activated = false;
  private acceptingCallbacks = false;
  private closing = false;
  private activationPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    @IAgentScopeContext private readonly agentContext: IAgentScopeContext,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionExtensionService private readonly extensions: ISessionExtensionService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
  }

  async activate(): Promise<void> {
    if (this.agentContext.agentId !== MAIN_AGENT_ID) return;
    if (this.shutdownPromise !== undefined) return;
    this.activationPromise ??= this.activateMain();
    await this.activationPromise;
  }

  shutdown(): Promise<void> {
    if (this.agentContext.agentId !== MAIN_AGENT_ID) return Promise.resolve();
    if (this.shutdownPromise === undefined) {
      this.closing = true;
      this.acceptingCallbacks = false;
      this.shutdownPromise = this.shutdownMain();
    }
    return this.shutdownPromise;
  }

  private async activateMain(): Promise<void> {
    await this.extensions.ready;
    if (this.closing) return;

    this._register(
      this.extensions.registerReloadParticipant({
        prepareForReload: () => this.deactivateCatalog(),
        activateReloadedCatalog: () => this.activateCatalog(),
      }),
    );
    this.runtimeSubscriptions.add(
      this.eventBus.subscribe('turn.started', (event) => {
        this.emitDetached({ type: 'turn_start', prompt: event.prompt ?? '' });
      }),
    );
    this.runtimeSubscriptions.add(
      this.eventBus.subscribe('turn.ended', () => {
        this.emitDetached({ type: 'turn_end' });
      }),
    );
    this.runtimeSubscriptions.add(
      this.eventBus.subscribe('agent.status.updated', () => {
        if (this.activated) this.restoreActiveTools();
      }),
    );
    this.runtimeSubscriptions.add(
      this.toolExecutor.onBeforeExecuteTool(async (event) => {
        const result = await this.emitAccepted({
          type: 'tool_call',
          toolName: event.toolCall.name,
          toolInput: toRecord(event.args),
          toolCallId: event.toolCall.id,
        });
        if (result?.block === true) {
          event.veto({
            output: result.reason ?? 'Blocked by extension.',
            isError: true,
          });
        }
      }),
    );
    this.runtimeSubscriptions.add(
      this.toolExecutor.hooks.onDidExecuteTool.register(
        'agent-extension',
        async (context, next) => {
          await next();
          await this.emitAccepted({
            type: 'tool_result',
            toolName: context.toolCall.name,
            toolCallId: context.toolCall.id,
            isError: context.result.isError === true,
            output: resultOutputText(context.result.output),
          });
        },
      ),
    );

    await this.activateCatalog();
  }

  private async shutdownMain(): Promise<void> {
    if (this.activationPromise !== undefined) await this.activationPromise;
    this.runtimeSubscriptions.clear();
    await this.deactivateCatalog();
    this.clearRegisteredTools();
  }

  async activateCommand(input: ActivateExtensionCommandInput): Promise<boolean> {
    if (this.agentContext.agentId !== MAIN_AGENT_ID) return false;
    if (this.shutdownPromise !== undefined) return false;
    await this.extensions.ready;
    if (!this.acceptingCallbacks) return false;
    return this.enqueueOperation(async () => {
      const resolved = this.extensions.resolveCommand(input.extensionId, input.name);
      if (resolved?.command.prompt === undefined) return false;
      try {
        const content = await resolved.command.prompt(input.args ?? '');
        await this.enqueueUserMessage(content);
        return true;
      } catch (error) {
        this.publishHandlerError(resolved.extensionPath, `command:${input.name}`, error);
        return false;
      }
    });
  }

  private registerTools(generation: number): void {
    this.clearRegisteredTools();
    for (const extension of this.extensions.list()) {
      for (const tool of extension.tools.values()) {
        if (this.toolRegistry.resolve(tool.name) !== undefined) {
          this.publishWarning(
            'extension.tool_conflict',
            `Extension tool "${tool.name}" from ${extension.path} conflicts with an existing tool.`,
          );
          continue;
        }
        const executable = this.toExecutableTool(tool, generation);
        this.toolRegistrations.add(
          this.toolRegistry.register(executable, {
            source: 'user',
            disclosure: tool.disclosure,
          }),
        );
        this.registeredToolNames.add(tool.name);
        this.profile.addActiveTool(tool.name);
      }
    }
  }

  private clearRegisteredTools(): void {
    this.toolRegistrations.clear();
    for (const name of this.registeredToolNames) this.profile.removeActiveTool(name);
    this.registeredToolNames.clear();
  }

  private restoreActiveTools(): void {
    for (const name of this.registeredToolNames) this.profile.addActiveTool(name);
  }

  private toExecutableTool(tool: ExtensionTool, generation: number): ExecutableTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      resolveExecution: (args) => ({
        approvalRule: tool.name,
        execute: async (context) => this.executeTool(tool, generation, args, context),
      }),
    };
  }

  private async executeTool(
    tool: ExtensionTool,
    generation: number,
    args: unknown,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (!this.acceptingCallbacks || generation !== this.catalogGeneration) {
      throw new Error(`Extension tool "${tool.name}" is no longer active.`);
    }
    return this.enqueueOperation(async () => {
      const result = await tool.execute({
        args: toRecord(args),
        signal: context.signal,
        turnId: String(context.turnId),
        toolCallId: context.toolCallId,
      });
      return result.isError === true
        ? {
            output: result.output,
            isError: true,
            note: result.message,
          }
        : {
            output: result.output,
            isError: false,
            note: result.message,
          };
    });
  }

  private activateCatalog(): Promise<void> {
    if (this.closing || this.activated) return this.operationTail;
    this.activated = true;
    const generation = ++this.catalogGeneration;
    return this.enqueueOperation(async () => {
      this.registerTools(generation);
      await this.emit({ type: 'session_start' });
      if (this.activated && !this.closing) this.acceptingCallbacks = true;
    });
  }

  private deactivateCatalog(): Promise<void> {
    if (!this.activated) return this.operationTail;
    this.activated = false;
    this.acceptingCallbacks = false;
    return this.enqueueOperation(async () => {
      await this.emit({ type: 'session_shutdown' });
    });
  }

  private emitAccepted(input: ExtensionEventInput): Promise<ToolCallEventResult | undefined> {
    if (!this.acceptingCallbacks) return Promise.resolve(undefined);
    return this.enqueueOperation(() => this.emit(input));
  }

  private emitDetached(input: ExtensionEventInput): void {
    void this.emitAccepted(input).catch((error: unknown) => {
      this.publishHandlerError('runtime', input.type, error);
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async emit(input: ExtensionEventInput): Promise<ToolCallEventResult | undefined> {
    const event = { ...input, sessionId: this.sessionContext.sessionId } as ExtensionEvent;
    const context = this.createContext();
    for (const extension of this.extensions.list()) {
      const handlers = extension.handlers.get(event.type);
      if (handlers === undefined) continue;
      for (const handler of handlers) {
        try {
          const result = (await handler(event, context)) as ToolCallEventResult | undefined;
          if (event.type === 'tool_call' && result?.block === true) return result;
        } catch (error) {
          this.publishHandlerError(extension.path, event.type, error);
        }
      }
    }
    return undefined;
  }

  private createContext(): ExtensionContext {
    return {
      cwd: this.profile.data().cwd,
      sessionId: this.sessionContext.sessionId,
      sendUserMessage: (content) => {
        void this.enqueueUserMessage(content).catch((error: unknown) => {
          this.publishHandlerError('runtime', 'sendUserMessage', error);
        });
      },
      notify: (message) => {
        this.eventBus.publish({ type: 'extension.notice', message });
      },
      setModel: async (modelAlias) => {
        await this.profile.setModel(modelAlias);
        return true;
      },
      setActiveTools: (toolNames) => {
        this.profile.update({ activeToolNames: [...toolNames] });
      },
      getActiveTools: () =>
        this.toolRegistry
          .list()
          .filter((tool) => this.toolPolicy.isToolActive(tool.name, tool.source))
          .map((tool) => tool.name),
    };
  }

  private async enqueueUserMessage(content: string): Promise<void> {
    await this.prompt.enqueue({
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
  }

  private publishHandlerError(extensionPath: string, event: string, error: unknown): void {
    this.publishWarning(
      'extension.handler_error',
      `Extension ${extensionPath} failed on ${event}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private publishWarning(code: string, message: string): void {
    this.eventBus.publish({ type: 'warning', code, message });
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resultOutputText(output: ExecutableToolResult['output']): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentExtensionService,
  AgentExtensionService,
  ScopeActivation.OnDemand,
  'agentExtension',
);
