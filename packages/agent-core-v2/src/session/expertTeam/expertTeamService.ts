/**
 * `expertTeam` domain (L6) — drives the active plugin-defined expert team.
 *
 * Gates the mode through `flag`, discovers expert packages through `plugin`,
 * reloads their roles through `sessionAgentProfileCatalog`, applies the lead
 * binding through `profile`, owns member identities through `agentLifecycle`,
 * steers live messages through `prompt` / `loop`, and records replayable mode
 * state through `wire`. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import {
  discoverDirectoryExperts,
  mergeDirectoryExperts,
  sessionExpertRoots,
} from '#/app/plugin/directoryExperts';
import { IPluginService } from '#/app/plugin/plugin';
import {
  EXPERT_TEAMS_FLAG_ID,
  normalizePluginId,
  pluginExpertProfileName,
  type EnabledPluginExpert,
} from '#/app/plugin/types';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IWireService } from '#/wire/wire';

import {
  type ExpertTeamMember,
  type ExpertTeamDefinition,
  type ExpertTeamMemberStatus,
  type ExpertTeamRuntime,
  type ExpertTeamSendMessageInput,
  type ExpertTeamSendMessageResult,
  type ExpertTeamSnapshot,
  type ExpertTeamSpawnTarget,
  ISessionExpertTeamService,
} from './expertTeam';
import {
  expertTeamActivate,
  expertTeamCreate,
  expertTeamDeactivate,
  expertTeamDelete,
  expertTeamMemberUpsert,
  ExpertTeamModel,
} from './expertTeamOps';

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SessionExpertTeamService
  extends Disposable
  implements ISessionExpertTeamService
{
  declare readonly _serviceBrand: undefined;

  private readonly pendingSpawns = new Set<string>();
  private readonly onDidChangeEmitter = this._register(
    new Emitter<ExpertTeamSnapshot | null>(),
  );
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  /** Installed plugin experts merged with drop-in `experts/` directory packages. */
  private async enabledExperts(): Promise<readonly EnabledPluginExpert[]> {
    const directory = await discoverDirectoryExperts(
      sessionExpertRoots(this.workspace.workDir, this.bootstrap.homeDir),
    );
    for (const issue of directory.issues) {
      this.log.warn(`Skipping directory expert package at ${issue.dir}: ${issue.message}`);
    }
    return mergeDirectoryExperts(directory.experts, await this.plugins.enabledExperts());
  }

  async listAvailable(): Promise<readonly ExpertTeamDefinition[]> {
    if (!this.flags.enabled(EXPERT_TEAMS_FLAG_ID)) return [];
    const experts = await this.enabledExperts();
    return experts.flatMap((expert) => {
      if (expert.type !== 'team' || expert.teamInfo === undefined) return [];
      return [{
        pluginId: expert.pluginId,
        pluginVersion: expert.pluginVersion,
        displayName: expert.displayName,
        description: expert.description,
        profession: expert.profession,
        tags: [...(expert.tags ?? [])],
        leadAgentName: expert.teamInfo.leadAgent,
        memberAgentNames: [...expert.teamInfo.memberAgents],
        members: (expert.members ?? []).map((member) => ({ ...member })),
        quickPrompts: [...(expert.quickPrompts ?? [])],
        defaultInitPrompt: expert.defaultInitPrompt,
        categoryId: expert.categoryId,
      }];
    });
  }

  snapshot(): ExpertTeamSnapshot | null {
    const main = this.lifecycle.get(MAIN_AGENT_ID);
    return main?.accessor.get(IWireService).getModel(ExpertTeamModel) ?? null;
  }

  async activate(pluginId: string): Promise<ExpertTeamSnapshot> {
    if (!this.flags.enabled(EXPERT_TEAMS_FLAG_ID)) {
      throw invalid(
        `Expert-team mode is experimental. Enable "${EXPERT_TEAMS_FLAG_ID}" before activating it.`,
      );
    }
    await this.ensureMain();
    const normalizedId = normalizePluginId(pluginId.trim());
    const current = this.snapshot();
    if (current !== null) {
      if (current.binding.pluginId === normalizedId) return current;
      throw invalid(
        `Expert team "${current.binding.pluginId}" is already active. Deactivate it first.`,
      );
    }

    const expert = (await this.enabledExperts()).find(
      (candidate) => candidate.pluginId === normalizedId,
    );
    if (expert === undefined) {
      throw invalid(`Enabled expert plugin "${normalizedId}" was not found.`);
    }
    if (expert.type !== 'team' || expert.teamInfo === undefined) {
      throw invalid(`Expert plugin "${normalizedId}" is not an expert team.`);
    }

    await this.catalog.reload();
    const leadProfileName = pluginExpertProfileName(normalizedId, expert.teamInfo.leadAgent);
    const leadProfile = this.catalog.get(leadProfileName);
    if (leadProfile === undefined) {
      throw invalid(`Lead profile "${leadProfileName}" is unavailable.`);
    }

    const mainProfile = this.mainHandle().accessor.get(IAgentProfileService);
    if (mainProfile.data().profileName === undefined) {
      await mainProfile.applyProfile(this.catalog.getDefault());
    }
    const previous = mainProfile.data();
    const snapshot: ExpertTeamSnapshot = {
      binding: {
        pluginId: normalizedId,
        pluginVersion: expert.pluginVersion,
        displayName: expert.displayName,
        leadAgentName: expert.teamInfo.leadAgent,
        leadProfileName,
        memberAgentNames: [...expert.teamInfo.memberAgents],
        previousProfile: {
          profileName: previous.profileName,
          modelAlias: previous.modelAlias,
          thinkingLevel: previous.thinkingLevel,
          cwd: previous.cwd,
          systemPrompt: previous.systemPrompt,
          activeToolNames: previous.activeToolNames,
          disallowedTools: previous.disallowedTools,
          subagents: previous.subagents,
        },
        activatedAt: new Date().toISOString(),
      },
    };

    await mainProfile.applyProfile(leadProfile);
    try {
      this.mainWire().dispatch(expertTeamActivate({ snapshot }));
    } catch (error) {
      mainProfile.applyBindingSnapshot(snapshot.binding.previousProfile);
      throw error;
    }
    this.fireSnapshot();
    return this.requireSnapshot();
  }

  async deactivate(): Promise<void> {
    const current = this.snapshot();
    if (current === null) return;
    if (current.team !== undefined) {
      await this.deleteTeam(MAIN_AGENT_ID);
    }
    const previous = current.binding.previousProfile;
    this.mainHandle().accessor.get(IAgentProfileService).applyBindingSnapshot(previous);
    this.mainWire().dispatch(expertTeamDeactivate({}));
    this.fireSnapshot();
  }

  createTeam(
    callerAgentId: string,
    input: { readonly name: string; readonly description?: string },
  ): ExpertTeamRuntime {
    this.requireLead(callerAgentId);
    const current = this.requireSnapshot();
    if (current.team !== undefined) {
      throw invalid(`Expert team "${current.team.name}" already exists.`);
    }
    const name = input.name.trim();
    if (!TEAM_NAME_PATTERN.test(name)) {
      throw invalid(
        'team_name must start with a lowercase letter or digit and contain only lowercase letters, digits, "-" or "_".',
      );
    }
    const team: ExpertTeamRuntime = {
      id: name,
      name,
      description: nonEmpty(input.description),
      createdAt: new Date().toISOString(),
      members: [],
    };
    this.mainWire().dispatch(expertTeamCreate({ team }));
    this.fireSnapshot();
    return team;
  }

  reserveMember(callerAgentId: string, memberName: string): ExpertTeamSpawnTarget {
    this.requireLead(callerAgentId);
    const current = this.requireSnapshot();
    const team = current.team;
    if (team === undefined) {
      throw invalid('Create the expert team with TeamCreate before spawning members.');
    }
    const normalizedName = memberName.trim();
    if (!current.binding.memberAgentNames.includes(normalizedName)) {
      throw invalid(
        `Member "${normalizedName}" is not declared by expert team "${current.binding.pluginId}".`,
      );
    }
    const agentId = `${normalizedName}@${team.id}`;
    const existing = team.members.find((member) => member.agentId === agentId);
    if (existing?.status === 'spawning' || existing?.status === 'running') {
      throw invalid(`Expert-team member "${normalizedName}" is already active.`);
    }
    const member: ExpertTeamMember = {
      name: normalizedName,
      agentId,
      profileName: pluginExpertProfileName(current.binding.pluginId, normalizedName),
      status: 'spawning',
      updatedAt: new Date().toISOString(),
      taskId: existing?.taskId,
    };
    this.pendingSpawns.add(agentId);
    try {
      this.upsertMember(member);
    } catch (error) {
      this.pendingSpawns.delete(agentId);
      throw error;
    }
    return {
      teamId: team.id,
      memberName: member.name,
      agentId: member.agentId,
      profileName: member.profileName,
      existing: existing !== undefined,
    };
  }

  markMemberRunning(agentId: string, taskId: string): void {
    this.pendingSpawns.delete(agentId);
    const member = this.requireMemberByAgentId(agentId);
    this.upsertMember({
      ...member,
      status: 'running',
      updatedAt: new Date().toISOString(),
      taskId,
    });
  }

  markMemberFinished(
    agentId: string,
    status: Extract<ExpertTeamMemberStatus, 'completed' | 'failed'>,
  ): void {
    this.pendingSpawns.delete(agentId);
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined || member.status === 'shutdown') return;
    this.upsertMember({ ...member, status, updatedAt: new Date().toISOString() });
  }

  async sendMessage(
    input: ExpertTeamSendMessageInput,
  ): Promise<ExpertTeamSendMessageResult> {
    const content = input.content.trim();
    if (content.length === 0) throw invalid('content must not be empty.');
    const current = this.requireSnapshot();
    const team = current.team;
    if (team === undefined) throw invalid('No expert team has been created.');
    const route = this.resolveMessageRoute(input, current);
    const target = this.lifecycle.get(route.targetAgentId);
    if (target === undefined) {
      throw invalid(`Message recipient "${input.recipient}" is not available.`);
    }

    if (route.targetMember !== undefined) {
      const loop = target.accessor.get(IAgentLoopService);
      if (loop.status().state === 'idle') {
        this.upsertMember({
          ...route.targetMember,
          status: 'running',
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const turn = await target.accessor.get(IAgentPromptService).inject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: teamMessageText({
            teamId: team.id,
            fromAgentId: input.callerAgentId,
            messageType: input.messageType,
            content,
          }),
        },
      ],
      toolCalls: [],
      origin: {
        kind: 'team_message',
        teamId: team.id,
        fromAgentId: input.callerAgentId,
        toAgentId: route.targetAgentId,
        messageType: input.messageType,
      },
    });

    if (route.targetMember !== undefined && turn !== undefined) {
      void turn.result.then((result) => {
        this.markMemberFinished(
          route.targetAgentId,
          result.type === 'completed' ? 'completed' : 'failed',
        );
      });
    }
    if (
      input.messageType === 'shutdown_response' &&
      input.callerAgentId !== MAIN_AGENT_ID
    ) {
      const caller = this.requireMemberByAgentId(input.callerAgentId);
      this.upsertMember({
        ...caller,
        status: 'shutdown',
        updatedAt: new Date().toISOString(),
      });
    }
    return { targetAgentId: route.targetAgentId, turnId: turn?.id };
  }

  async deleteTeam(callerAgentId: string): Promise<void> {
    this.requireLead(callerAgentId);
    const current = this.requireSnapshot();
    if (current.team === undefined) return;
    const active = current.team.members.filter((member) => {
      if (this.pendingSpawns.has(member.agentId)) return true;
      return (
        this.lifecycle.get(member.agentId)?.accessor.get(IAgentLoopService).status().state ===
        'running'
      );
    });
    if (active.length > 0) {
      throw invalid(
        `Cannot delete expert team while members are active: ${active
          .map((member) => member.name)
          .join(', ')}.`,
      );
    }
    this.mainWire().dispatch(expertTeamDelete({}));
    this.fireSnapshot();
  }

  private resolveMessageRoute(
    input: ExpertTeamSendMessageInput,
    current: ExpertTeamSnapshot,
  ): { readonly targetAgentId: string; readonly targetMember?: ExpertTeamMember } {
    if (input.callerAgentId === MAIN_AGENT_ID) {
      if (input.messageType === 'shutdown_response') {
        throw invalid('Only expert-team members may send shutdown_response.');
      }
      const member = current.team?.members.find(
        (candidate) =>
          candidate.name === input.recipient || candidate.agentId === input.recipient,
      );
      if (member === undefined) {
        throw invalid(`Expert-team member "${input.recipient}" has not been spawned.`);
      }
      return { targetAgentId: member.agentId, targetMember: member };
    }

    this.requireMemberByAgentId(input.callerAgentId);
    if (input.messageType === 'shutdown_request') {
      throw invalid('Only the expert-team lead may send shutdown_request.');
    }
    if (
      input.recipient !== MAIN_AGENT_ID &&
      input.recipient !== current.binding.leadAgentName &&
      input.recipient !== 'team-lead'
    ) {
      throw invalid('Expert-team members may only send messages to the lead.');
    }
    return { targetAgentId: MAIN_AGENT_ID };
  }

  private upsertMember(member: ExpertTeamMember): void {
    this.mainWire().dispatch(expertTeamMemberUpsert({ member }));
    this.fireSnapshot();
  }

  private findMemberByAgentId(agentId: string): ExpertTeamMember | undefined {
    return this.snapshot()?.team?.members.find((member) => member.agentId === agentId);
  }

  private requireMemberByAgentId(agentId: string): ExpertTeamMember {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) {
      throw invalid(`Agent "${agentId}" is not a member of the active expert team.`);
    }
    return member;
  }

  private requireLead(callerAgentId: string): void {
    if (callerAgentId !== MAIN_AGENT_ID) {
      throw invalid('Only the expert-team lead may perform this operation.');
    }
  }

  private requireSnapshot(): ExpertTeamSnapshot {
    const snapshot = this.snapshot();
    if (snapshot === null) throw invalid('No expert-team mode is active.');
    return snapshot;
  }

  private mainHandle() {
    const main = this.lifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) throw invalid('The main agent is not available.');
    return main;
  }

  private async ensureMain(): Promise<void> {
    if (this.lifecycle.get(MAIN_AGENT_ID) !== undefined) return;
    await this.lifecycle.create({ agentId: MAIN_AGENT_ID });
  }

  private mainWire(): IWireService {
    return this.mainHandle().accessor.get(IWireService);
  }

  private fireSnapshot(): void {
    this.onDidChangeEmitter.fire(this.snapshot());
  }
}

function invalid(message: string): Error2 {
  return new Error2(ErrorCodes.REQUEST_INVALID, message);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function teamMessageText(input: {
  readonly teamId: string;
  readonly fromAgentId: string;
  readonly messageType: ExpertTeamSendMessageInput['messageType'];
  readonly content: string;
}): string {
  return [
    `<expert-team-message team="${escapeAttribute(input.teamId)}" from="${escapeAttribute(
      input.fromAgentId,
    )}" type="${input.messageType}">`,
    input.content,
    '</expert-team-message>',
  ].join('\n');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExpertTeamService,
  SessionExpertTeamService,
  ScopeActivation.OnScopeCreated,
  'expertTeam',
);
