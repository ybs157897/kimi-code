/**
 * `expertTeam` domain (L6) — `TeamSpawn` declared-member launcher.
 *
 * The lead reserves one plugin-declared member, creates or resumes its stable
 * `name@team` Agent, applies the member profile, and starts a detached turn.
 * The ordinary Agent tool and the swarm coordinator are not involved.
 */

import { z } from 'zod';

import { ILogService } from '#/_base/log/log';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { EXPERT_TEAMS_FLAG_ID } from '#/app/plugin/types';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { resolveSubagentTimeoutMs } from '#/session/subagent/configSection';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SubagentTask, type SubagentHandle } from '#/session/subagent/tools/subagent-task';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  type BuiltinTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
  ToolAccesses,
} from '#/tool/toolContract';

import {
  type ExpertTeamSpawnTarget,
  ISessionExpertTeamService,
} from '../expertTeam';

export const TeamSpawnInputSchema = z.object({
  name: z.string().describe('Declared expert member agent id from the active plugin.'),
  prompt: z.string().describe('Self-contained specialist assignment.'),
  description: z.string().describe('Short task description for progress display.'),
});

export type TeamSpawnInput = z.infer<typeof TeamSpawnInputSchema>;

export class TeamSpawnTool implements BuiltinTool<TeamSpawnInput> {
  readonly name = 'TeamSpawn';
  readonly description =
    'Spawn or continue one declared expert-team member in the background. Call TeamCreate first. The member must return authoritative findings with SendMessage.';
  readonly parameters = toInputJsonSchema(TeamSpawnInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ISessionExpertTeamService private readonly expertTeam: ISessionExpertTeamService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: TeamSpawnInput): ToolExecution {
    return {
      description: `Launching expert-team member ${args.name}: ${args.description}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      display: {
        kind: 'agent_call',
        agent_name: args.name,
        prompt: args.prompt,
        background: true,
      },
      execute: (context) => this.execute(args, context),
    };
  }

  private async execute(
    args: TeamSpawnInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    let target: ExpertTeamSpawnTarget | undefined;
    let controller: AbortController | undefined;
    try {
      context.signal.throwIfAborted();
      target = this.expertTeam.reserveMember(this.callerAgentId, args.name);
      const requester = this.lifecycle.get(this.callerAgentId);
      if (requester === undefined) throw new Error('The expert-team lead is not available.');

      await this.catalog.ready;
      const profile = this.catalog.get(target.profileName);
      if (profile === undefined) {
        throw new Error(`Expert member profile "${target.profileName}" is unavailable.`);
      }
      const member = await this.getOrCreateMember(target, profile);
      if (member.accessor.get(IAgentLoopService).status().state === 'running') {
        throw new Error(`Expert-team member "${target.memberName}" is already running.`);
      }

      member.accessor
        .get(IAgentPermissionModeService)
        .setMode(requester.accessor.get(IAgentPermissionModeService).mode);
      member.accessor
        .get(IAgentUserToolService)
        .inheritUserTools(requester.accessor.get(IAgentUserToolService));

      const prompt = await applyProfilePromptPrefix(
        profile,
        assignmentPrompt(target, args.prompt),
        {
          cwd: this.session.cwd,
          runner: this.processRunner,
          log: this.log,
        },
      );
      controller = new AbortController();
      emitAgentRunSpawned(requester, target.agentId, {
        profileName: target.profileName,
        parentToolCallId: context.toolCallId,
        description: args.description,
        runInBackground: true,
      });
      const run = await this.subagents.run(
        target.agentId,
        { kind: 'prompt', prompt },
        { signal: controller.signal },
      );
      const reserved = target;
      const completion = mirrorAgentRun(requester, run, {
        profileName: target.profileName,
        prompt,
        signal: controller.signal,
        cancel: (reason) => controller?.abort(reason),
      }).then(
        (result) => {
          this.expertTeam.markMemberFinished(reserved.agentId, 'completed');
          return { result: result.summary, usage: result.usage };
        },
        (error) => {
          this.expertTeam.markMemberFinished(reserved.agentId, 'failed');
          throw error;
        },
      );
      const handle: SubagentHandle = {
        agentId: target.agentId,
        profileName: target.profileName,
        completion,
      };
      const taskId = this.tasks.registerTask(
        new SubagentTask(handle, args.description, controller),
        {
          detached: true,
          timeoutMs: resolveSubagentTimeoutMs(this.config),
        },
      );
      this.expertTeam.markMemberRunning(target.agentId, taskId);
      await this.tasks.suppressTerminalNotification(taskId);
      return {
        output: [
          '<expert_team_member_started>',
          `member: ${target.memberName}`,
          `agent_id: ${target.agentId}`,
          `task_id: ${taskId}`,
          'status: running',
          'Findings will arrive through SendMessage.',
          '</expert_team_member_started>',
        ].join('\n'),
      };
    } catch (error) {
      controller?.abort(error);
      if (target !== undefined) {
        this.expertTeam.markMemberFinished(target.agentId, 'failed');
      }
      this.log.warn('expert-team member launch failed', {
        callerAgentId: this.callerAgentId,
        memberName: args.name,
        toolCallId: context.toolCallId,
        error,
      });
      return { output: errorMessage(error), isError: true };
    }
  }

  private async getOrCreateMember(
    target: ExpertTeamSpawnTarget,
    profile: AgentProfile,
  ) {
    const existing = this.lifecycle.get(target.agentId);
    if (existing !== undefined) return existing;
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) throw new Error('The expert-team lead is not available.');
    const callerProfile = requester.accessor.get(IAgentProfileService).data();
    if (callerProfile.modelAlias === undefined) {
      throw new Error('The expert-team lead has no model bound.');
    }
    return this.lifecycle.create({
      agentId: target.agentId,
      binding: {
        profile: profile.name,
        model: callerProfile.modelAlias,
        thinking: callerProfile.thinkingLevel,
        cwd: callerProfile.cwd,
      },
      labels: {
        parentAgentId: this.callerAgentId,
        expertTeamId: target.teamId,
        expertMemberName: target.memberName,
      },
    });
  }
}

registerTool(TeamSpawnTool, {
  when: (accessor) => accessor.get(IFlagService).enabled(EXPERT_TEAMS_FLAG_ID),
});

function assignmentPrompt(target: ExpertTeamSpawnTarget, prompt: string): string {
  return [
    `<expert-team-assignment team="${target.teamId}" member="${target.memberName}" lead="main">`,
    prompt,
    '',
    'When finished, call SendMessage with recipient "team-lead" and include your complete authoritative findings.',
    '</expert-team-assignment>',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
