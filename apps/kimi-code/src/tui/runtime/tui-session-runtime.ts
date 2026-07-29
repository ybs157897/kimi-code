import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type { ExtensionCommandPort } from './extension-command-port';
import { createKlientAgentEventsPort } from './klient-agent-events-adapter';
import { createKlientExtensionCommandPort } from './klient-extension-command-adapter';
import { createKlientSessionBtwPort } from './klient-session-btw-adapter';
import { createKlientSessionContextControlPort } from './klient-session-context-control-adapter';
import { createKlientSessionContextViewPort } from './klient-session-context-view-adapter';
import { createKlientSessionControlPort } from './klient-session-control-adapter';
import { createKlientSessionScopedEventsPort } from './klient-session-events-adapter';
import { createKlientSessionExpertTeamPort } from './klient-session-expert-team-adapter';
import { createKlientSessionGoalQueuePort } from './klient-session-goal-queue-adapter';
import { createKlientSessionInitPort } from './klient-session-init-adapter';
import { createKlientSessionMcpPort } from './klient-session-mcp-adapter';
import { createKlientSessionPluginCommandsPort } from './klient-session-plugin-commands-adapter';
import { createKlientSessionPluginsPort } from './klient-session-plugins-adapter';
import { createKlientSessionRefreshPort } from './klient-session-refresh-adapter';
import { createKlientSessionSkillsPort } from './klient-session-skills-adapter';
import { createKlientSessionSwarmPort } from './klient-session-swarm-adapter';
import { createKlientSessionWarningsPort } from './klient-session-warnings-adapter';
import { createKlientSessionWorkspacePort } from './klient-session-workspace-adapter';
import type { SessionBtwPort } from './session-btw-port';
import {
  MAIN_AGENT_ID,
  type SessionAgentControlPort,
  type SessionLifecyclePort,
} from './session-control-port';
import type { SessionContextControlPort } from './session-context-control-port';
import type { SessionContextViewPort } from './session-context-view-port';
import type { AgentEventsPort } from './agent-events-port';
import type { SessionScopedEventsPort } from './session-events-port';
import type { SessionExpertTeamPort } from './session-expert-team-port';
import type { SessionGoalQueuePort } from './session-goal-queue-port';
import type { SessionInitPort } from './session-init-port';
import type { SessionMcpPort } from './session-mcp-port';
import type { SessionPluginCommandsPort } from './session-plugin-commands-port';
import type { SessionPluginsPort } from './session-plugins-port';
import type { SessionRefreshPort } from './session-refresh-port';
import type { SessionSkillsPort } from './session-skills-port';
import type { SessionSwarmPort } from './session-swarm-port';
import type { SessionWarningsPort } from './session-warnings-port';
import type { SessionWorkspacePort } from './session-workspace-port';

type Klient = KimiV2Runtime['klient'];

export interface TUISessionRuntime {
  readonly sessionId: string;
  readonly agentId: string;
  readonly lifecycle: SessionLifecyclePort;
  readonly agent: SessionAgentControlPort;
  readonly swarm: SessionSwarmPort;
  readonly expertTeam: SessionExpertTeamPort;
  readonly init: SessionInitPort;
  readonly btw: SessionBtwPort;
  readonly context: SessionContextControlPort;
  readonly contextView: SessionContextViewPort;
  readonly sessionEvents: SessionScopedEventsPort;
  readonly agentEvents: AgentEventsPort;
  readonly goalQueue: SessionGoalQueuePort;
  readonly mcp: SessionMcpPort;
  readonly pluginCommands: SessionPluginCommandsPort;
  readonly plugins: SessionPluginsPort;
  readonly refresh: SessionRefreshPort;
  readonly extensionCommands: ExtensionCommandPort;
  readonly skills: SessionSkillsPort;
  readonly warnings: SessionWarningsPort;
  readonly workspace: SessionWorkspacePort;
}

/** Bind one Klient session scope and interactive agent to neutral TUI ports. */
export function createKlientTUISessionRuntime(
  runtime: KimiV2Runtime | Klient,
  sessionId: string,
  agentId = MAIN_AGENT_ID,
): TUISessionRuntime {
  const klient = 'klient' in runtime ? runtime.klient : runtime;
  const session = klient.session(sessionId);
  const control = createKlientSessionControlPort(klient);
  return {
    sessionId,
    agentId,
    lifecycle: control.session(sessionId),
    agent: control.agent(sessionId, agentId),
    swarm: createKlientSessionSwarmPort(klient, sessionId, agentId),
    expertTeam: createKlientSessionExpertTeamPort(session),
    init: createKlientSessionInitPort(session),
    btw: createKlientSessionBtwPort(session),
    context: createKlientSessionContextControlPort(session, agentId),
    contextView: createKlientSessionContextViewPort(session, agentId),
    sessionEvents: createKlientSessionScopedEventsPort(session, sessionId, agentId),
    agentEvents: createKlientAgentEventsPort(session, sessionId, agentId),
    goalQueue: createKlientSessionGoalQueuePort(session),
    mcp: createKlientSessionMcpPort(session, agentId),
    pluginCommands: createKlientSessionPluginCommandsPort(
      klient,
      sessionId,
      agentId,
    ),
    plugins: createKlientSessionPluginsPort({ klient }),
    refresh: createKlientSessionRefreshPort(klient, sessionId),
    extensionCommands: createKlientExtensionCommandPort(session, agentId),
    skills: createKlientSessionSkillsPort(session, agentId),
    warnings: createKlientSessionWarningsPort(session),
    workspace: createKlientSessionWorkspacePort(session),
  };
}
