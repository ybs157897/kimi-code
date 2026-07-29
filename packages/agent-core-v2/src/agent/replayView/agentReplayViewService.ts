/**
 * `replayView` domain (L5) — `IAgentReplayView` implementation.
 *
 * Composes final state from the Agent-scoped public views owned by `profile`,
 * `contextMemory`, `contextSize`, `permissionGate`, `plan`, `swarm`, `usage`,
 * `toolRegistry`, and `agentTask`, while `wire` supplies the persisted facts
 * folded into the replay timeline. Reads identity through `scopeContext`.
 * Bound at Agent scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ResumedAgentState } from '#/agent/replayBuilder/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IWireService } from '#/wire/wire';

import { IAgentReplayView } from './agentReplayView';
import { buildAgentReplayRecords } from './buildAgentReplayRecords';

export class AgentReplayViewService implements IAgentReplayView {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IWireService private readonly wire: IWireService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentPermissionGate private readonly permission: IAgentPermissionGate,
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @IAgentSwarmService private readonly swarm: IAgentSwarmService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  async read(): Promise<ResumedAgentState> {
    const profile = this.profile.data();
    const history = this.context.get();
    const [plan, wireRecords] = await Promise.all([
      this.plan.status(),
      this.wire.readRecords(),
    ]);
    return {
      type: this.scopeContext.agentId === 'main' ? 'main' : 'sub',
      config: {
        cwd: profile.cwd,
        modelAlias: profile.modelAlias,
        modelCapabilities: profile.modelCapabilities,
        profileName: profile.profileName,
        thinkingLevel: profile.thinkingLevel,
        systemPrompt: profile.systemPrompt,
      },
      context: {
        history,
        tokenCount: this.contextSize.get().size,
      },
      replay: buildAgentReplayRecords(wireRecords),
      permission: this.permission.data(),
      plan,
      swarmMode: this.swarm.isActive,
      usage: this.usage.status(),
      tools: this.tools.list(),
      tasks: this.tasks.list(false),
      // TODO(CORE-103): wire ISessionTodoService to populate typed todos
      todos: [],
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentReplayView,
  AgentReplayViewService,
  ScopeActivation.OnDemand,
  'replayView',
);
