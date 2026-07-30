/**
 * The agent facade — one `session.agent(id)` handle over the agent-scope
 * services the wire exposes. Turn-driving calls (prompt / steer / cancel) go
 * through the `agentRPCService` channel; shell commands, model, usage, plan,
 * and task calls go straight to their domain services. Prompt streaming is
 * NOT on this interface: it flows through the agent's `events` hub
 * (`turn.*`, `assistant.delta`, `tool.call.*`, `prompt.completed`, …).
 */

import type { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import type {
  GoalReasonInput,
  IAgentGoalService,
  ResumeGoalInput,
} from '@moonshot-ai/agent-core-v2/agent/goal/goal';
import type {
  CreateGoalInput,
  GoalSnapshot,
} from '@moonshot-ai/agent-core-v2/agent/goal/types';
import type { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import type { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import type { IAgentReplayView } from '@moonshot-ai/agent-core-v2/agent/replayView/agentReplayView';
import type {
  BindAgentInput,
  IAgentProfileService,
  ProfileData,
} from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import type { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type { ActivateExtensionCommandInput } from '@moonshot-ai/agent-core-v2/agent/extension/agentExtension';
import type { SkillActivationInput } from '@moonshot-ai/agent-core-v2/agent/skill/skill';
import type { ActivatePluginCommandPayload } from '@moonshot-ai/agent-core-v2/agent/rpc/core-api';
import type { ContextImportInput } from '@moonshot-ai/agent-core-v2/agent/contextCommand/contextCommand';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './session.js';

// Wire-type aliases derived through the engine service interfaces (keeps
// klient free of protocol-package imports).
export type PromptLaunchResult = Awaited<ReturnType<IAgentRPCService['prompt']>>;
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
export type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;
export type UsageStatus = Awaited<ReturnType<IAgentUsageService['status']>>;
export type AgentContextData = Awaited<ReturnType<IAgentRPCService['getContext']>>;
export type PlanData = Awaited<ReturnType<IAgentPlanService['status']>>;
export type AgentTaskInfo = Awaited<ReturnType<IAgentTaskService['list']>>[number];
export type ResumedAgentState = Awaited<ReturnType<IAgentReplayView['read']>>;
export type McpServerEntry = Awaited<ReturnType<IAgentMcpService['list']>>[number];
export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface AgentExtensionsFacade {
  activateCommand(input: ActivateExtensionCommandInput): Promise<boolean>;
}

export interface AgentGoalFacade {
  get(): Promise<GoalSnapshot | null>;
  create(input: CreateGoalInput): Promise<GoalSnapshot>;
  pause(input?: GoalReasonInput): Promise<GoalSnapshot>;
  resume(input?: ResumeGoalInput): Promise<GoalSnapshot>;
  cancel(input?: GoalReasonInput): Promise<GoalSnapshot>;
}

export interface AgentProfileFacade {
  bind(input: BindAgentInput): Promise<void>;
  get(): Promise<ProfileData>;
  setThinking(level: string): Promise<void>;
}

export interface AgentReplayFacade {
  read(): Promise<ResumedAgentState>;
}

export interface AgentSkillsFacade {
  activate(input: SkillActivationInput): Promise<void>;
}

export interface AgentMcpFacade {
  list(): Promise<readonly McpServerEntry[]>;
  reconnect(name: string): Promise<void>;
  initialLoadDurationMs(): Promise<number>;
}

export interface AgentPluginsFacade {
  refreshSessionStartReminder(): Promise<void>;
}

export interface AgentSwarmFacade {
  isActive(): Promise<boolean>;
  enter(trigger: SwarmModeTrigger): Promise<void>;
  exit(): Promise<void>;
}

export interface AgentFacade {
  prompt(input: {
    input: readonly ContentPart[];
    disabledTools?: readonly string[];
  }): Promise<PromptLaunchResult>;
  steer(input: { input: readonly ContentPart[] }): Promise<PromptLaunchResult>;
  cancel(input?: { turnId?: number }): Promise<void>;
  activatePluginCommand(input: ActivatePluginCommandPayload): Promise<void>;
  runShellCommand(input: { command: string; commandId?: string }): Promise<ShellCommandResult>;
  cancelShellCommand(input: { commandId: string }): Promise<void>;
  getModel(): Promise<string>;
  setModel(model: string): Promise<SetModelResult>;
  getPermission(): Promise<PermissionMode>;
  setPermission(mode: PermissionMode): Promise<void>;
  getUsage(): Promise<UsageStatus>;
  getContext(): Promise<AgentContextData>;
  clearContext(): Promise<void>;
  importContext(input: ContextImportInput): Promise<void>;
  compact(input?: { instruction?: string }): Promise<boolean>;
  cancelCompaction(): Promise<void>;
  undoHistory(count?: number): Promise<number>;
  getPlan(): Promise<PlanData>;
  enterPlan(): Promise<void>;
  clearPlan(): Promise<void>;
  cancelPlan(input?: { id?: string }): Promise<void>;
  getTasks(input?: { activeOnly?: boolean; limit?: number }): Promise<readonly AgentTaskInfo[]>;
  detachTask(input: { taskId: string }): Promise<AgentTaskInfo | undefined>;
  stopTask(input: { taskId: string; reason?: string }): Promise<void>;
  getTaskOutput(input: { taskId: string; tail?: number }): Promise<string>;
  readonly mcp: AgentMcpFacade;
  readonly plugins: AgentPluginsFacade;
  readonly goal: AgentGoalFacade;
  readonly profile: AgentProfileFacade;
  readonly replay: AgentReplayFacade;
  readonly skills: AgentSkillsFacade;
  readonly swarm: AgentSwarmFacade;
  readonly extensions: AgentExtensionsFacade;
}

export function createAgentFacade(call: ScopedCaller, scope: ScopeRef): AgentFacade {
  const rpc = (method: string, payload: unknown): Promise<unknown> =>
    call(scope, 'agentRPCService', method, [payload]);

  return {
    prompt: (input) => rpc('prompt', input) as Promise<PromptLaunchResult>,
    steer: (input) => rpc('steer', input) as Promise<PromptLaunchResult>,
    cancel: (input) => rpc('cancel', input ?? {}) as Promise<void>,
    activatePluginCommand: (input) =>
      rpc('activatePluginCommand', input) as Promise<void>,
    runShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'run', [input]) as Promise<ShellCommandResult>,
    cancelShellCommand: (input) =>
      call(scope, 'agentShellCommandService', 'cancel', [input.commandId]) as Promise<void>,
    getModel: () => call(scope, 'agentProfileService', 'getModel', []) as Promise<string>,
    setModel: (model) =>
      call(scope, 'agentProfileService', 'setModel', [model]) as Promise<SetModelResult>,
    getPermission: () =>
      call(scope, 'agentPermissionModeService', 'mode', []) as Promise<PermissionMode>,
    setPermission: (mode) => rpc('setPermission', { mode }) as Promise<void>,
    getUsage: () => call(scope, 'agentUsageService', 'status', []) as Promise<UsageStatus>,
    getContext: () => rpc('getContext', {}) as Promise<AgentContextData>,
    clearContext: () =>
      call(scope, 'agentContextCommandService', 'clear', []) as Promise<void>,
    importContext: (input) =>
      call(scope, 'agentContextCommandService', 'importContext', [input]) as Promise<void>,
    compact: (input) =>
      call(scope, 'agentFullCompactionService', 'begin', [
        { source: 'manual', instruction: input?.instruction },
      ]) as Promise<boolean>,
    cancelCompaction: () => rpc('cancelCompaction', {}) as Promise<void>,
    undoHistory: (count = 1) => rpc('undoHistory', { count }) as Promise<number>,
    getPlan: () => call(scope, 'agentPlanService', 'status', []) as Promise<PlanData>,
    enterPlan: () => call(scope, 'agentPlanService', 'enter', []) as Promise<void>,
    clearPlan: () => call(scope, 'agentPlanService', 'clear', []) as Promise<void>,
    cancelPlan: (input) =>
      call(scope, 'agentPlanService', 'cancel', [input?.id]) as Promise<void>,
    getTasks: (input) =>
      call(scope, 'agentTaskService', 'list', [
        input?.activeOnly ?? false,
        input?.limit,
      ]) as Promise<readonly AgentTaskInfo[]>,
    detachTask: (input) =>
      call(scope, 'agentTaskService', 'detach', [input.taskId]) as Promise<
        AgentTaskInfo | undefined
      >,
    stopTask: async (input) => {
      if (input.reason === undefined) {
        await call(scope, 'agentTaskService', 'stopByUser', [input.taskId]);
        return;
      }
      await call(scope, 'agentTaskService', 'stop', [input.taskId, input.reason]);
    },
    getTaskOutput: (input) =>
      call(scope, 'agentTaskService', 'readOutput', [input.taskId, input.tail]) as Promise<string>,
    mcp: {
      list: () =>
        call(scope, 'agentMcpService', 'list', []) as Promise<readonly McpServerEntry[]>,
      reconnect: (name) =>
        call(scope, 'agentMcpService', 'reconnect', [name]) as Promise<void>,
      initialLoadDurationMs: () =>
        call(scope, 'agentMcpService', 'initialLoadDurationMs', []) as Promise<number>,
    },
    plugins: {
      refreshSessionStartReminder: () =>
        call(
          scope,
          'agentPluginService',
          'appendFreshSessionStartReminder',
          [],
        ) as Promise<void>,
    },
    goal: {
      get: async () => {
        const result = (await call(scope, 'agentGoalService', 'getGoal', [])) as Awaited<
          ReturnType<IAgentGoalService['getGoal']>
        >;
        return result.goal;
      },
      create: (input) =>
        call(scope, 'agentGoalService', 'createGoal', [input]) as Promise<GoalSnapshot>,
      pause: (input) =>
        call(scope, 'agentGoalService', 'pauseGoal', [input ?? {}]) as Promise<GoalSnapshot>,
      resume: (input) =>
        call(scope, 'agentGoalService', 'resumeGoal', [input ?? {}]) as Promise<GoalSnapshot>,
      cancel: (input) =>
        call(scope, 'agentGoalService', 'cancelGoal', [input ?? {}]) as Promise<GoalSnapshot>,
    },
    profile: {
      bind: (input) =>
        call(scope, 'agentProfileService', 'bind', [input]) as Promise<void>,
      get: () => call(scope, 'agentProfileService', 'data', []) as Promise<ProfileData>,
      setThinking: (level) =>
        call(scope, 'agentProfileService', 'setThinking', [level]) as Promise<void>,
    },
    replay: {
      read: () =>
        call(scope, 'agentReplayView', 'read', []) as Promise<ResumedAgentState>,
    },
    skills: {
      activate: (input) => rpc('activateSkill', input) as Promise<void>,
    },
    swarm: {
      isActive: () =>
        call(scope, 'agentSwarmService', 'isActive', []) as Promise<boolean>,
      enter: (trigger) =>
        call(scope, 'agentSwarmService', 'enter', [trigger]) as Promise<void>,
      exit: () => call(scope, 'agentSwarmService', 'exit', []) as Promise<void>,
    },
    extensions: {
      activateCommand: (input) =>
        call(scope, 'agentExtensionService', 'activateCommand', [input]) as Promise<boolean>,
    },
  };
}
