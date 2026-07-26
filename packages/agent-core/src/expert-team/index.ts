import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';

import type { EnabledPluginExpert, PluginExpertMember } from '../plugin';
import { DEFAULT_AGENT_PROFILES, type ResolvedAgentProfile } from '../profile';

export * from './discovery';
export * from './runtime';

export interface ExpertTeamDefinition {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly profession?: string;
  readonly tags: readonly string[];
  readonly leadAgentName: string;
  readonly memberAgentNames: readonly string[];
  readonly members: readonly PluginExpertMember[];
  readonly quickPrompts: readonly string[];
  readonly defaultInitPrompt?: string;
  readonly categoryId?: string;
}

export interface ExpertTeamSnapshot {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly displayName: string;
  readonly leadAgentName: string;
  readonly previousProfileName?: string;
  readonly activatedAt: string;
}

export interface ExpertTeamRuntime extends ExpertTeamDefinition {
  readonly leadProfile: ResolvedAgentProfile;
  readonly memberProfiles: Readonly<Record<string, ResolvedAgentProfile>>;
}

interface ExpertAgentSource {
  readonly name: string;
  readonly description?: string;
  readonly prompt: string;
}

const UNAVAILABLE_LEAD_TOOLS = new Set(['AgentSwarm']);
const UNAVAILABLE_MEMBER_TOOLS = new Set(['Agent', 'AgentSwarm', 'AskUserQuestion']);

export async function loadExpertTeams(
  experts: readonly EnabledPluginExpert[],
  options: {
    readonly onError?: (expert: EnabledPluginExpert, error: unknown) => void;
  } = {},
): Promise<readonly ExpertTeamRuntime[]> {
  const teams: ExpertTeamRuntime[] = [];
  for (const expert of experts) {
    if (expert.type !== 'team' || expert.teamInfo === undefined) continue;
    try {
      teams.push(await loadExpertTeam(expert));
    } catch (error) {
      options.onError?.(expert, error);
    }
  }
  return teams.toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

async function loadExpertTeam(expert: EnabledPluginExpert): Promise<ExpertTeamRuntime> {
  const teamInfo = expert.teamInfo;
  if (teamInfo === undefined) {
    throw new Error(`Expert team plugin "${expert.pluginId}" is missing teamInfo`);
  }
  const sources = new Map<string, ExpertAgentSource>();
  for (const agentPath of expert.agents) {
    const source = parseExpertAgentSource(agentPath, await readFile(agentPath, 'utf8'));
    sources.set(source.name, source);
  }

  const memberProfiles: Record<string, ResolvedAgentProfile> = {};
  for (const memberName of teamInfo.memberAgents) {
    const source = requireExpertAgentSource(sources, memberName);
    memberProfiles[memberName] = createMemberProfile(expert, source, teamInfo.memberAgents);
  }
  const leadSource = requireExpertAgentSource(sources, teamInfo.leadAgent);
  const leadProfile = createLeadProfile(expert, leadSource, memberProfiles);

  return {
    pluginId: expert.pluginId,
    pluginVersion: expert.pluginVersion,
    displayName: expert.displayName,
    description: expert.displayDescription ?? expert.description,
    profession: expert.profession,
    tags: expert.tags ?? [],
    leadAgentName: teamInfo.leadAgent,
    memberAgentNames: teamInfo.memberAgents,
    members: expert.members ?? [],
    quickPrompts: expert.quickPrompts ?? [],
    defaultInitPrompt: expert.defaultInitPrompt,
    categoryId: expert.categoryId,
    leadProfile,
    memberProfiles,
  };
}

function createLeadProfile(
  expert: EnabledPluginExpert,
  source: ExpertAgentSource,
  memberProfiles: Readonly<Record<string, ResolvedAgentProfile>>,
): ResolvedAgentProfile {
  const base = requireDefaultProfile();
  return {
    name: expertProfileName(expert.pluginId, source.name),
    description: source.description,
    systemPrompt: (context) =>
      [
        base.systemPrompt(context),
        '',
        `<expert_role_override plugin="${expert.pluginId}" role="lead" agent="${source.name}">`,
        source.prompt,
        '</expert_role_override>',
        '',
        '<expert_team_runtime>',
        'This expert team is already active. Treat TeamCreate in the package SOP as completed.',
        'You are the only expert-team agent that may speak to the end user.',
        '',
        'Dispatching work:',
        '- Use the Agent tool to assign a member their initial task. It returns',
        '  immediately with a dispatch receipt; members work asynchronously.',
        '- Member reports arrive as <teammate-message> entries in your conversation.',
        '  They are internal signals — never quote them verbatim to the user; synthesize.',
        '- To follow up, correct, or continue with a member, use',
        '  SendMessage(type="message", recipient="<member>"). Never call Agent twice for',
        '  the same member and never use Agent(resume=...).',
        `- Declared members (subagent_type): ${Object.keys(memberProfiles).join(', ')}.`,
        '',
        'Shutting down:',
        '- Before deactivating the team, SendMessage(type="shutdown_request") to each',
        '  active member and wait for their shutdown_response. Members are',
        '  force-stopped after a timeout.',
        '</expert_team_runtime>',
      ].join('\n'),
    tools: [
      ...base.tools.filter((tool) => !UNAVAILABLE_LEAD_TOOLS.has(tool)),
      'SendMessage',
    ],
    subagents: { ...memberProfiles },
  };
}

function createMemberProfile(
  expert: EnabledPluginExpert,
  source: ExpertAgentSource,
  memberNames: readonly string[],
): ResolvedAgentProfile {
  const base = requireDefaultProfile();
  const teammates = memberNames.filter((name) => name !== source.name);
  return {
    name: source.name,
    description: source.description,
    systemPrompt: (context) =>
      [
        base.systemPrompt(context),
        '',
        `<expert_role_override plugin="${expert.pluginId}" role="member" agent="${source.name}">`,
        source.prompt,
        '</expert_role_override>',
        '',
        '<expert_team_runtime>',
        `You are member "${source.name}" of expert team "${expert.displayName}".`,
        `Your teammates: ${[...teammates, 'team-lead'].join(', ')}.`,
        'Plain-text output is NOT visible to the lead. The ONLY way to report anything',
        'is SendMessage(type="message", recipient="team-lead").',
        '- Send your complete professional findings to team-lead before you stop. Do not',
        '  summarize-and-trail-off; the message body must be the full deliverable.',
        '- Tasks and follow-ups arrive as <teammate-message> entries.',
        '- On a <teammate-message> shutdown request: finish and send your final results',
        '  first, then reply SendMessage(type="shutdown_response", request_id=..., approve=true).',
        '- Do not address the end user, and do not create, delete, or spawn agents.',
        '</expert_team_runtime>',
      ].join('\n'),
    tools: [
      ...base.tools.filter((tool) => !UNAVAILABLE_MEMBER_TOOLS.has(tool)),
      'SendMessage',
    ],
  };
}

function parseExpertAgentSource(agentPath: string, text: string): ExpertAgentSource {
  const fileName = path.basename(agentPath, path.extname(agentPath));
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  if (match === null) {
    throw new Error(`Expert agent file "${agentPath}" must start with YAML frontmatter`);
  }
  const frontmatter = loadYaml(match[1] ?? '');
  if (!isObject(frontmatter)) {
    throw new Error(`Expert agent frontmatter at "${agentPath}" must be an object`);
  }
  const name = requiredString(frontmatter, 'name', agentPath);
  if (name !== fileName) {
    throw new Error(`Expert agent name "${name}" must match file name "${fileName}"`);
  }
  const prompt = (match[2] ?? '').trim();
  if (prompt.length === 0) {
    throw new Error(`Expert agent file "${agentPath}" must contain a prompt`);
  }
  return {
    name,
    description: optionalString(frontmatter, 'description'),
    prompt,
  };
}

function requireExpertAgentSource(
  sources: ReadonlyMap<string, ExpertAgentSource>,
  name: string,
): ExpertAgentSource {
  const source = sources.get(name);
  if (source === undefined) {
    throw new Error(`Expert agent "${name}" was not found`);
  }
  return source;
}

function requireDefaultProfile(): ResolvedAgentProfile {
  const profile = DEFAULT_AGENT_PROFILES['agent'];
  if (profile === undefined) {
    throw new Error('Default agent profile was not found');
  }
  return profile;
}

function expertProfileName(pluginId: string, agentName: string): string {
  return `expert:${pluginId}:${agentName}`;
}

function requiredString(
  raw: Record<string, unknown>,
  key: string,
  agentPath: string,
): string {
  const value = optionalString(raw, key);
  if (value === undefined) {
    throw new Error(`Expert agent frontmatter at "${agentPath}" requires "${key}"`);
  }
  return value;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
