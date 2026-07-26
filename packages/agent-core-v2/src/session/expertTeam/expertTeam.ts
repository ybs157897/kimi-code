/**
 * `expertTeam` domain (L6) — Session-scoped expert-team contract.
 *
 * An expert team is an independently activated session mode backed by an
 * enabled expert plugin. The service owns the active plugin binding, the
 * lead/member roster, member lifecycle state, and the star-topology message
 * channel. It does not depend on the swarm domain.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import type { PluginLocalizedText } from '#/app/plugin/types';

export type ExpertTeamMemberStatus =
  | 'spawning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'shutdown';

export interface ExpertTeamBinding {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly leadAgentName: string;
  readonly leadProfileName: string;
  readonly memberAgentNames: readonly string[];
  readonly previousProfile: ProfileBindingSnapshot;
  readonly activatedAt: string;
}

export interface ExpertTeamMember {
  readonly name: string;
  readonly agentId: string;
  readonly profileName: string;
  readonly status: ExpertTeamMemberStatus;
  readonly updatedAt: string;
  readonly taskId?: string;
}

export interface ExpertTeamRuntime {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly members: readonly ExpertTeamMember[];
}

export interface ExpertTeamSnapshot {
  readonly binding: ExpertTeamBinding;
  readonly team?: ExpertTeamRuntime;
}

export interface ExpertTeamDefinition {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly profession?: string;
  readonly tags: readonly string[];
  readonly leadAgentName: string;
  readonly memberAgentNames: readonly string[];
  readonly members: readonly {
    readonly agent: string;
    readonly role: 'lead' | 'member';
    readonly displayName?: string;
    readonly name?: PluginLocalizedText;
    readonly profession?: PluginLocalizedText;
    readonly description?: string;
    readonly avatar?: string;
  }[];
  readonly quickPrompts: readonly string[];
  readonly defaultInitPrompt?: string;
  readonly categoryId?: string;
}

export interface ExpertTeamSpawnTarget {
  readonly teamId: string;
  readonly memberName: string;
  readonly agentId: string;
  readonly profileName: string;
  readonly existing: boolean;
}

export type ExpertTeamMessageType = 'message' | 'shutdown_request' | 'shutdown_response';

export interface ExpertTeamSendMessageInput {
  readonly callerAgentId: string;
  readonly recipient: string;
  readonly content: string;
  readonly messageType: ExpertTeamMessageType;
}

export interface ExpertTeamSendMessageResult {
  readonly targetAgentId: string;
  readonly turnId?: number;
}

export interface ISessionExpertTeamService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<ExpertTeamSnapshot | null>;
  listAvailable(): Promise<readonly ExpertTeamDefinition[]>;
  snapshot(): ExpertTeamSnapshot | null;
  activate(pluginId: string): Promise<ExpertTeamSnapshot>;
  deactivate(): Promise<void>;
  createTeam(
    callerAgentId: string,
    input: { readonly name: string; readonly description?: string },
  ): ExpertTeamRuntime;
  reserveMember(callerAgentId: string, memberName: string): ExpertTeamSpawnTarget;
  markMemberRunning(agentId: string, taskId: string): void;
  markMemberFinished(agentId: string, status: Extract<ExpertTeamMemberStatus, 'completed' | 'failed'>): void;
  sendMessage(input: ExpertTeamSendMessageInput): Promise<ExpertTeamSendMessageResult>;
  deleteTeam(callerAgentId: string): Promise<void>;
}

export const ISessionExpertTeamService: ServiceIdentifier<ISessionExpertTeamService> =
  createDecorator<ISessionExpertTeamService>('sessionExpertTeamService');
