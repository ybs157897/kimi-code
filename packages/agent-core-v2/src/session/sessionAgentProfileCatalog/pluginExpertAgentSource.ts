/**
 * `sessionAgentProfileCatalog` domain (L3) — plugin expert `IAgentProfileSource`.
 *
 * Discovers role files through `plugin`, reads them through `hostFileSystem`,
 * composes them with the `userFileAgentSource` default profile, gates them
 * through `flag`, and reports invalid roles through `log`. Bound at Session
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import type { Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { parseAgentFileText } from '#/app/agentFileCatalog/agentFile';
import { agentProfileFromFile } from '#/app/agentFileCatalog/agentProfileFromFile';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import {
  EXPERT_TEAMS_FLAG_ID,
  type EnabledPluginExpert,
  pluginExpertProfileName,
} from '#/app/plugin/types';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

export interface IPluginExpertAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IPluginExpertAgentSource: ServiceIdentifier<IPluginExpertAgentSource> =
  createDecorator<IPluginExpertAgentSource>('pluginExpertAgentSource');

const LEAD_REQUIRED_TOOLS = ['TeamCreate', 'TeamSpawn', 'SendMessage', 'TeamDelete'] as const;
const LEAD_DISALLOWED_TOOLS = ['Agent', 'AgentSwarm'] as const;
const MEMBER_REQUIRED_TOOLS = ['SendMessage', 'TodoList'] as const;
const MEMBER_DISALLOWED_TOOLS = [
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'TeamCreate',
  'TeamDelete',
  'TeamSpawn',
] as const;

export class PluginExpertAgentSource implements IPluginExpertAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'plugin-expert';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.pluginExpert;
  readonly onDidChange: Event<void> = (listener, thisArg, disposables) =>
    this.plugins.onDidReload(
      () => listener.call(thisArg, undefined as void),
      undefined,
      disposables,
    );

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IUserFileAgentSource private readonly user: IUserFileAgentSource,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    if (!this.flags.enabled(EXPERT_TEAMS_FLAG_ID)) {
      return { profiles: [], skipped: [], scannedRoots: [] };
    }
    const experts = await this.plugins.enabledExperts();
    const profiles: AgentProfile[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const expert of experts) {
      for (const agentPath of expert.agents) {
        try {
          profiles.push(await this.loadProfile(expert, agentPath));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skipped.push({ path: agentPath, reason });
          this.log.warn(`Skipping invalid expert agent file at ${agentPath}: ${reason}`);
        }
      }
    }
    return {
      profiles,
      skipped,
      scannedRoots: experts.map((expert) => expert.pluginRoot),
    };
  }

  private async loadProfile(
    expert: EnabledPluginExpert,
    agentPath: string,
  ): Promise<AgentProfile> {
    const localName = fileStem(agentPath);
    const definition = parseAgentFileText({
      path: agentPath,
      source: 'plugin',
      text: await this.fs.readText(agentPath),
    });
    if (definition.name !== localName) {
      throw new Error(
        `Agent frontmatter name "${definition.name}" must match file name "${localName}"`,
      );
    }
    const role = expert.teamInfo?.leadAgent === localName ? 'lead' : 'member';
    const runtimeName = pluginExpertProfileName(expert.pluginId, localName);
    const requiredTools = role === 'lead' ? LEAD_REQUIRED_TOOLS : MEMBER_REQUIRED_TOOLS;
    const deniedTools = role === 'lead' ? LEAD_DISALLOWED_TOOLS : MEMBER_DISALLOWED_TOOLS;
    const tools =
      definition.tools === undefined
        ? undefined
        : [...new Set([...definition.tools, ...requiredTools])];
    const disallowedTools = [
      ...new Set([...(definition.disallowedTools ?? []), ...deniedTools]),
    ];
    const subagents =
      role === 'lead'
        ? expert.teamInfo?.memberAgents.map((name) =>
            pluginExpertProfileName(expert.pluginId, name),
          )
        : [];
    const rolePrompt = expertRolePrompt(expert, localName, role, definition.prompt);
    return agentProfileFromFile(
      {
        ...definition,
        name: runtimeName,
        prompt: rolePrompt,
        tools,
        disallowedTools,
        subagents,
        override: true,
      },
      (context) => this.user.getDefaultProfile().systemPrompt(context),
    );
  }
}

function expertRolePrompt(
  expert: EnabledPluginExpert,
  agentName: string,
  role: 'lead' | 'member',
  prompt: string,
): string {
  const runtime =
    role === 'lead'
      ? [
          'You are the only expert-team agent that may speak to the end user.',
          'Call TeamCreate before spawning members. Whenever the package SOP says to use Agent,',
          'call TeamSpawn instead and pass the declared member Agent ID as name.',
          'Treat SendMessage as the authoritative channel for member findings.',
          'Use TodoList for shared progress when the workflow benefits from explicit tracking.',
          'Shut down active members before calling TeamDelete.',
        ].join(' ')
      : [
          `You are member "${agentName}" of expert team "${expert.displayName}".`,
          `Send complete professional findings to lead "${expert.agentName}" with SendMessage.`,
          'Do not address the end user directly and do not create or delete the team.',
        ].join(' ');
  return [
    '${base_prompt}',
    '',
    `<expert_role_override plugin="${expert.pluginId}" role="${role}" agent="${agentName}">`,
    prompt,
    '</expert_role_override>',
    '',
    `<expert_team_runtime>${runtime}</expert_team_runtime>`,
  ].join('\n');
}

function fileStem(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]*$/, '');
}

registerScopedService(
  LifecycleScope.Session,
  IPluginExpertAgentSource,
  PluginExpertAgentSource,
  InstantiationType.Eager,
  'sessionAgentProfileCatalog',
);
