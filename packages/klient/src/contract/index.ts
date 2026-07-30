/**
 * The aggregated klient contract — service wire name → method → zod
 * input/output schemas, across the core/session/agent scopes. The klient
 * factory validates every call against this table; transports never see it.
 * Event registrations live in the per-scope `events.ts` files alongside
 * their payload schemas.
 */

import type { KlientContract } from './types.js';
import { agentActivityViewContract } from './agent/activity.js';
import { agentExtensionContract } from './agent/extension.js';
import { agentGoalContract } from './agent/goal.js';
import { agentPermissionModeContract } from './agent/permission.js';
import { agentRpcContract } from './agent/rpc.js';
import { agentSwarmContract } from './agent/swarm.js';
import {
  agentFullCompactionContract,
  agentMcpContract,
  agentPlanContract,
  agentPluginContract,
  agentProfileContract,
  agentReplayViewContract,
  agentShellCommandContract,
  agentTaskContract,
  agentUsageContract,
} from './agent/services.js';
import { authContract, authSummaryContract } from './global/auth.js';
import { catalogContract } from './global/catalog.js';
import { providerDiscoveryContract } from './global/providerDiscovery.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import {
  mcpCatalogContract,
  mcpOAuthContract,
  mcpProbeContract,
} from './global/mcp.js';
import { modelsContract } from './global/models.js';
import { pluginsContract } from './global/plugins.js';
import { providersContract } from './global/providers.js';
import { sessionExportContract } from './global/session-export.js';
import { sessionStoreContract } from './global/session-store.js';
import { sessionsContract } from './global/sessions.js';
import { workspaceSkillCatalogContract } from './global/skills.js';
import { workspacesContract } from './global/workspaces.js';
import { agentContextCommandContract } from './agent/contextCommand.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionBtwContract } from './session/btw.js';
import { sessionCronContract } from './session/cron.js';
import { sessionExpertTeamContract } from './session/expertTeam.js';
import { sessionExtensionContract } from './session/extension.js';
import { sessionGoalQueueContract } from './session/goal-queue.js';
import { sessionInteractionContract } from './session/interaction.js';
import { sessionInitContract } from './session/init.js';
import { sessionLifecycleContract } from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSkillCatalogContract } from './session/skill.js';
import { sessionTodoContract } from './session/todo.js';
import { sessionSecondaryModelWarningContract } from './session/warnings.js';
import {
  sessionWorkspaceCommandContract,
  sessionWorkspaceContextContract,
} from './session/workspace.js';

export const globalContract: KlientContract = {
  // core (app scope)
  sessionIndex: sessionsContract,
  workspaceSkillCatalogService: workspaceSkillCatalogContract,
  workspaceService: workspacesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  sessionExportService: sessionExportContract,
  sessionSnapshotStore: sessionStoreContract,
  mcpCatalogService: mcpCatalogContract,
  mcpOAuthService: mcpOAuthContract,
  mcpProbeService: mcpProbeContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  // session scope (+ the app-registered lifecycle service)
  sessionLifecycleService: sessionLifecycleContract,
  sessionMetadata: sessionMetadataContract,
  sessionInteractionService: sessionInteractionContract,
  sessionInitService: sessionInitContract,
  sessionBtwService: sessionBtwContract,
  sessionApprovalService: sessionApprovalContract,
  sessionQuestionService: sessionQuestionContract,
  sessionCronService: sessionCronContract,
  sessionExpertTeamService: sessionExpertTeamContract,
  sessionExtensionService: sessionExtensionContract,
  sessionGoalQueueService: sessionGoalQueueContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  sessionTodoService: sessionTodoContract,
  sessionSecondaryModelWarningService: sessionSecondaryModelWarningContract,
  sessionWorkspaceContext: sessionWorkspaceContextContract,
  sessionWorkspaceCommandService: sessionWorkspaceCommandContract,
  // agent scope
  agentRPCService: agentRpcContract,
  agentFullCompactionService: agentFullCompactionContract,
  agentMcpService: agentMcpContract,
  agentPluginService: agentPluginContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentExtensionService: agentExtensionContract,
  agentGoalService: agentGoalContract,
  agentSwarmService: agentSwarmContract,
  agentActivityView: agentActivityViewContract,
  agentShellCommandService: agentShellCommandContract,
  agentProfileService: agentProfileContract,
  agentReplayView: agentReplayViewContract,
  agentUsageService: agentUsageContract,
  agentPlanService: agentPlanContract,
  agentTaskService: agentTaskContract,
  agentContextCommandService: agentContextCommandContract,
};

export type { KlientContract, ProcedureContract, ServiceContract, StreamingProcedureContract } from './types.js';
export { isStreamingContract } from './types.js';
