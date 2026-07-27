/**
 * Runtime-neutral expert-team discovery and control for one bound session.
 *
 * A roster is optional because an active team binding can exist before the
 * runtime has created its live team and member state.
 */

export type SessionExpertTeamMemberStatus =
  | 'not_started'
  | 'idle'
  | 'spawning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'shutdown';

export interface SessionExpertTeamDefinition {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly leadAgentName: string;
  readonly memberAgentNames: readonly string[];
  readonly quickPrompts: readonly string[];
}

export interface SessionExpertTeamMember {
  readonly name: string;
  readonly agentId?: string;
  readonly status: SessionExpertTeamMemberStatus;
}

export interface SessionExpertTeamSnapshot {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly leadAgentName: string;
  readonly activatedAt: string;
  readonly members?: readonly SessionExpertTeamMember[];
}

export interface SessionExpertTeamPort {
  list(): Promise<readonly SessionExpertTeamDefinition[]>;
  get(): Promise<SessionExpertTeamSnapshot | null>;
  activate(pluginId: string): Promise<SessionExpertTeamSnapshot>;
  deactivate(): Promise<void>;
}
