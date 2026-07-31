/**
 * Local shapes for the legacy agent-core RPC protocol that the SDK RPC
 * client talks to — the `CoreAPI` method surface and its resolved form.
 */

import type { RPCMethods } from '#/sdk-rpc';

// Local CoreAPI interface — structurally compatible with the legacy
// @moonshot-ai/agent-core CoreAPI that the SDK RPC client expects.
// Defined locally so the SDK need not import that package.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CoreAPI {
  createSession(payload: Record<string, unknown>): any;
  resumeSession(payload: Record<string, unknown>): any;
  reloadSession(payload: Record<string, unknown>): any;
  forkSession(payload: Record<string, unknown>): any;
  listSessions(payload: Record<string, unknown>): any;
  closeSession(payload: { readonly sessionId: string }): void;
  deleteSession(payload: { readonly sessionId: string }): void;
  renameSession(payload: Record<string, unknown>): void;
  getKimiConfig(payload: Record<string, unknown>): any;
  getConfigDiagnostics(payload: Record<string, unknown>): any;
  getExperimentalFeatures(payload: Record<string, unknown>): any;
  setKimiConfig(payload: Record<string, unknown>): any;
  removeKimiProvider(payload: Record<string, unknown>): any;
  listGlobalMcpServers(payload: Record<string, unknown>): any;
  addGlobalMcpServer(payload: Record<string, unknown>): any;
  updateGlobalMcpServer(payload: Record<string, unknown>): any;
  removeGlobalMcpServer(payload: Record<string, unknown>): any;
  beginGlobalMcpServerAuth(payload: Record<string, unknown>): any;
  completeGlobalMcpServerAuth(payload: Record<string, unknown>, options?: Record<string, unknown>): void;
  cancelGlobalMcpServerAuth(payload: Record<string, unknown>): void;
  resetGlobalMcpServerAuth(payload: Record<string, unknown>): void;
  testGlobalMcpServer(payload: Record<string, unknown>): any;
  prompt(payload: Record<string, unknown>): void;
  runShellCommand(payload: Record<string, unknown>): any;
  cancelShellCommand(payload: Record<string, unknown>): void;
  steer(payload: Record<string, unknown>): void;
  generateAgentsMd(payload: { readonly sessionId: string }): void;
  getSessionWarnings(payload: { readonly sessionId: string }): any;
  addAdditionalDir(payload: Record<string, unknown>): any;
  startBtw(payload: Record<string, unknown>): any;
  cancel(payload: Record<string, unknown>): void;
  clearContext(payload: Record<string, unknown>): void;
  importContext(payload: Record<string, unknown>): void;
  setModel(payload: Record<string, unknown>): any;
  setThinking(payload: Record<string, unknown>): void;
  setPermission(payload: Record<string, unknown>): void;
  getSessionMetadata(payload: { readonly sessionId: string }): any;
  updateSessionMetadata(payload: Record<string, unknown>): void;
  cancelPlan(payload: Record<string, unknown>): void;
  enterPlan(payload: Record<string, unknown>): void;
  enterSwarm(payload: Record<string, unknown>): void;
  exitSwarm(payload: Record<string, unknown>): void;
  getPlan(payload: Record<string, unknown>): any;
  clearPlan(payload: Record<string, unknown>): void;
  beginCompaction(payload: Record<string, unknown>): void;
  cancelCompaction(payload: Record<string, unknown>): void;
  undoHistory(payload: Record<string, unknown>): any;
  getContext(payload: Record<string, unknown>): any;
  getUsage(payload: Record<string, unknown>): any;
  getConfig(payload: Record<string, unknown>): any;
  getPermission(payload: Record<string, unknown>): any;
  getSwarmMode(payload: Record<string, unknown>): any;
  getExpertTeam(payload: Record<string, unknown>): any;
  getExpertTeamStatus(payload: Record<string, unknown>): any;
  exportSession(payload: Record<string, unknown>): any;
  listSkills(payload: { readonly sessionId: string }): any;
  listPluginCommands(payload: { readonly sessionId: string }): any;
  listExpertTeams(payload: { readonly sessionId: string }): any;
  listExtensionCommands(payload: { readonly sessionId: string }): any;
  getBackground(payload: Record<string, unknown>): any;
  getBackgroundOutput(payload: Record<string, unknown>): any;
  stopBackground(payload: Record<string, unknown>): void;
  detachBackground(payload: Record<string, unknown>): any;
  waitForBackgroundTasksOnPrint(payload: { readonly sessionId: string }): void;
  handlePrintMainTurnCompleted(payload: { readonly sessionId: string }): any;
  createGoal(payload: Record<string, unknown>): any;
  getGoal(payload: Record<string, unknown>): any;
  pauseGoal(payload: Record<string, unknown>): any;
  resumeGoal(payload: Record<string, unknown>): any;
  cancelGoal(payload: Record<string, unknown>): any;
  getCronTasks(payload: Record<string, unknown>): any;
  listMcpServers(payload: { readonly sessionId: string }): any;
  getMcpStartupMetrics(payload: { readonly sessionId: string }): any;
  reconnectMcpServer(payload: Record<string, unknown>): void;
  listPlugins(payload: Record<string, unknown>): any;
  installPlugin(payload: Record<string, unknown>): any;
  setPluginEnabled(payload: Record<string, unknown>): void;
  setPluginMcpServerEnabled(payload: Record<string, unknown>): void;
  removePlugin(payload: Record<string, unknown>): void;
  reloadPlugins(payload: Record<string, unknown>): any;
  getPluginInfo(payload: Record<string, unknown>): any;
  activateSkill(payload: Record<string, unknown>): void;
  activatePluginCommand(payload: Record<string, unknown>): void;
  activateExtensionCommand(payload: Record<string, unknown>): any;
  listWorkspaceSkills(payload: Record<string, unknown>): any;
  activateExpertTeam(payload: Record<string, unknown>): any;
  deactivateExpertTeam(payload: { readonly sessionId: string }): void;
}

// Local type aliases for legacy agent-core RPC protocol types.
// These match the shapes expected by the SDK RPC surface.
export type BeginGlobalMcpServerAuthResult =
  | { readonly status: 'already-authorized' }
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    };

export type ResolvedCoreAPI = RPCMethods<CoreAPI>;
