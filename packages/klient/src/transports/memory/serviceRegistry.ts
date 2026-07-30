/**
 * Service name → DI token registry for the in-process dispatcher. Only leaf
 * modules are imported (tokens + types) — never the engine root barrel, so
 * hosting klient in-process does not force the full registration side effects
 * beyond what the host already bootstrapped.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionSnapshotStore } from '@moonshot-ai/agent-core-v2/app/sessionStore/sessionSnapshotStore';
import { IMcpCatalogService } from '@moonshot-ai/agent-core-v2/app/mcpCatalog/mcpCatalog';
import { IMcpOAuthService } from '@moonshot-ai/agent-core-v2/app/mcpOAuth/mcpOAuth';
import { IMcpProbeService } from '@moonshot-ai/agent-core-v2/app/mcpProbe/mcpProbe';
import { IWorkspaceSkillCatalogService } from '@moonshot-ai/agent-core-v2/app/skillCatalog/workspaceSkillCatalog';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IModelService } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import { IProviderService } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import {
  IAuthSummaryService,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IPluginService } from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { IEventService } from '@moonshot-ai/agent-core-v2/app/event/event';
import { IHostFolderBrowser } from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';
import { ISessionExportService } from '@moonshot-ai/agent-core-v2/app/sessionExport/sessionExport';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { ISessionInitService } from '@moonshot-ai/agent-core-v2/session/sessionInit/sessionInit';
import { ISessionBtwService } from '@moonshot-ai/agent-core-v2/session/btw/btw';
import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionCronService } from '@moonshot-ai/agent-core-v2/session/cron/sessionCronService';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { ISessionExpertTeamService } from '@moonshot-ai/agent-core-v2/session/expertTeam/expertTeam';
import { ISessionExtensionService } from '@moonshot-ai/agent-core-v2/session/extension/sessionExtension';
import { ISessionGoalQueueService } from '@moonshot-ai/agent-core-v2/session/goalQueue/sessionGoalQueue';
import { ISessionSkillCatalog } from '@moonshot-ai/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
import { ISessionSecondaryModelWarningService } from '@moonshot-ai/agent-core-v2/session/subagent/secondaryModelWarning';
import { ISessionWorkspaceCommandService } from '@moonshot-ai/agent-core-v2/session/workspaceCommand/workspaceCommand';
import { ISessionWorkspaceContext } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceContext';
import { ISessionTodoService } from '@moonshot-ai/agent-core-v2/session/todo/sessionTodo';
import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import { IAgentExtensionService } from '@moonshot-ai/agent-core-v2/agent/extension/agentExtension';
import { IAgentGoalService } from '@moonshot-ai/agent-core-v2/agent/goal/goal';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentSwarmService } from '@moonshot-ai/agent-core-v2/agent/swarm/swarm';
import { IAgentActivityView } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import { IAgentFullCompactionService } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/fullCompaction';
import { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import { IAgentPluginService } from '@moonshot-ai/agent-core-v2/agent/plugin/agentPlugin';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentReplayView } from '@moonshot-ai/agent-core-v2/agent/replayView/agentReplayView';
import { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import { IAgentContextCommandService } from '@moonshot-ai/agent-core-v2/agent/contextCommand/contextCommand';

/** Wire service name (decorator id string) → token. */
export const serviceTokens: Readonly<Record<string, ServiceIdentifier<unknown>>> = {
  sessionIndex: ISessionIndex,
  sessionSnapshotStore: ISessionSnapshotStore,
  mcpCatalogService: IMcpCatalogService,
  mcpOAuthService: IMcpOAuthService,
  mcpProbeService: IMcpProbeService,
  workspaceSkillCatalogService: IWorkspaceSkillCatalogService,
  workspaceService: IWorkspaceService,
  configService: IConfigService,
  modelService: IModelService,
  modelResolver: IModelCatalog,
  providerDiscovery: IProviderDiscoveryService,
  providerService: IProviderService,
  oauthService: IOAuthService,
  authSummaryService: IAuthSummaryService,
  flagService: IFlagService,
  pluginService: IPluginService,
  hostFolderBrowser: IHostFolderBrowser,
  bootstrapService: IBootstrapService,
  sessionExportService: ISessionExportService,
  sessionLifecycleService: ISessionLifecycleService,
  sessionMetadata: ISessionMetadata,
  sessionInteractionService: ISessionInteractionService,
  sessionInitService: ISessionInitService,
  sessionBtwService: ISessionBtwService,
  sessionApprovalService: ISessionApprovalService,
  sessionCronService: ISessionCronService,
  sessionQuestionService: ISessionQuestionService,
  sessionExpertTeamService: ISessionExpertTeamService,
  sessionExtensionService: ISessionExtensionService,
  sessionGoalQueueService: ISessionGoalQueueService,
  sessionSkillCatalog: ISessionSkillCatalog,
  sessionSecondaryModelWarningService: ISessionSecondaryModelWarningService,
  sessionWorkspaceContext: ISessionWorkspaceContext,
  sessionWorkspaceCommandService: ISessionWorkspaceCommandService,
  sessionTodoService: ISessionTodoService,
  agentRPCService: IAgentRPCService,
  agentFullCompactionService: IAgentFullCompactionService,
  agentMcpService: IAgentMcpService,
  agentPluginService: IAgentPluginService,
  agentPermissionModeService: IAgentPermissionModeService,
  agentExtensionService: IAgentExtensionService,
  agentGoalService: IAgentGoalService,
  agentSwarmService: IAgentSwarmService,
  agentActivityView: IAgentActivityView,
  agentShellCommandService: IAgentShellCommandService,
  agentProfileService: IAgentProfileService,
  agentReplayView: IAgentReplayView,
  agentUsageService: IAgentUsageService,
  agentPlanService: IAgentPlanService,
  agentTaskService: IAgentTaskService,
  agentContextCommandService: IAgentContextCommandService,
};

export { IEventService };
