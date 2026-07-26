import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { HookDefSchema, type HookDefConfig } from '#/agent/externalHooks/configSection';
import { McpServerConfigSchema, type McpServerConfig } from '#/agent/mcp/config-schema';

import {
  PLUGIN_NAME_REGEX,
  type PluginCommandEntry,
  type PluginDiagnostic,
  type PluginExpert,
  type PluginLocalizedText,
  type PluginExpertMember,
  type PluginExpertTeamInfo,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
} from './types';

const KIMI_PLUGIN_ROOT_PATH = 'kimi.plugin.json';
const KIMI_PLUGIN_DIR_PATH = '.kimi-plugin/plugin.json';
const CODEBUDDY_PLUGIN_DIR_PATH = '.codebuddy-plugin/plugin.json';

const UNSUPPORTED_RUNTIME_FIELDS = [
  'tools',
  'apps',
  'inject',
  'configFile',
  'config_file',
  'bootstrap',
] as const;

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const rootJsonPath = path.join(pluginRoot, KIMI_PLUGIN_ROOT_PATH);
  const dirJsonPath = path.join(pluginRoot, KIMI_PLUGIN_DIR_PATH);
  const codebuddyJsonPath = path.join(pluginRoot, CODEBUDDY_PLUGIN_DIR_PATH);
  const rootJsonExists = await isFile(rootJsonPath);
  const dirJsonExists = await isFile(dirJsonPath);
  const codebuddyJsonExists = await isFile(codebuddyJsonPath);

  if (!rootJsonExists && !dirJsonExists && !codebuddyJsonExists) {
    return {
      diagnostics: [
        {
          severity: 'error',
          message: `No manifest at ${KIMI_PLUGIN_ROOT_PATH}, ${KIMI_PLUGIN_DIR_PATH}, or ${CODEBUDDY_PLUGIN_DIR_PATH}`,
        },
      ],
    };
  }

  const manifestPath = rootJsonExists
    ? rootJsonPath
    : dirJsonExists
      ? dirJsonPath
      : codebuddyJsonPath;
  const manifestKind: PluginManifestKind = rootJsonExists
    ? 'kimi-plugin-root'
    : dirJsonExists
      ? 'kimi-plugin-dir'
      : 'codebuddy-plugin-dir';
  const shadowedManifestPath = rootJsonExists
    ? dirJsonExists
      ? dirJsonPath
      : codebuddyJsonExists
        ? codebuddyJsonPath
        : undefined
    : dirJsonExists && codebuddyJsonExists
      ? codebuddyJsonPath
      : undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [{ severity: 'error', message: 'manifest must be a JSON object' }],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({ severity: 'error', message: '"name" is required' });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }

  let skills = await resolveSkillsField(pluginRoot, raw['skills'], diagnostics);
  if (raw['skills'] === undefined) {
    const rootSkillMd = path.join(pluginRoot, 'SKILL.md');
    if (await isFile(rootSkillMd)) {
      skills = [pluginRoot];
    }
  }

  const skillInstructions =
    typeof raw['skillInstructions'] === 'string' ? raw['skillInstructions'] : undefined;
  const expert = await readExpert(pluginRoot, raw, diagnostics);

  recordUnsupportedRuntimeFields(raw, diagnostics);

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    keywords: stringArrayField(raw, 'keywords'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    sessionStart: readSessionStart(raw['sessionStart'], diagnostics),
    mcpServers: await readMcpServers(pluginRoot, raw['mcpServers'], diagnostics),
    hooks: readHooks(raw['hooks'], diagnostics),
    commands: await readCommands(pluginRoot, raw['commands'], diagnostics),
    interface: readInterface(raw['interface'], raw),
    skillInstructions,
    expert,
  };

  return { manifest, manifestKind, manifestPath, shadowedManifestPath, diagnostics };
}

async function readExpert(
  pluginRoot: string,
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): Promise<PluginExpert | undefined> {
  const rawType = raw['expertType'];
  if (rawType === undefined) return undefined;
  if (rawType !== 'agent' && rawType !== 'team') {
    diagnostics.push({ severity: 'error', message: '"expertType" must be "agent" or "team"' });
    return undefined;
  }

  const agentName = stringField(raw, 'agentName');
  if (agentName === undefined) {
    diagnostics.push({
      severity: 'error',
      message: '"agentName" is required when "expertType" is present',
    });
    return undefined;
  }

  const agents = await readExpertAgentPaths(pluginRoot, raw['agents'], diagnostics);
  if (agents.length === 0) {
    diagnostics.push({
      severity: 'error',
      message: '"agents" must contain at least one .md file when "expertType" is present',
    });
  }

  const members = readExpertMembers(raw['members'], diagnostics);
  const teamInfo =
    rawType === 'team' ? readExpertTeamInfo(raw['teamInfo'], diagnostics) : undefined;
  validateExpertTopology({
    type: rawType,
    agentName,
    agentPaths: agents,
    teamInfo,
    members,
    diagnostics,
  });

  return {
    type: rawType,
    agentName,
    agents,
    teamInfo,
    members,
    profession: stringField(raw, 'profession'),
    displayDescription: stringField(raw, 'displayDescription'),
    tags: stringArrayField(raw, 'tags'),
    quickPrompts: stringArrayField(raw, 'quickPrompts'),
    defaultInitPrompt: stringField(raw, 'defaultInitPrompt'),
    categoryId: stringField(raw, 'categoryId'),
  };
}

async function readExpertAgentPaths(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) {
    return discoverExpertAgentPaths(pluginRoot);
  }
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
    diagnostics.push({ severity: 'error', message: '"agents" must be a string[]' });
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: 'agents',
      value: entry,
      diagnostics,
      severity: 'error',
    });
    if (resolved === undefined) continue;
    if (!(await isFile(resolved)) || !resolved.endsWith('.md')) {
      diagnostics.push({
        severity: 'error',
        message: `"agents" entry must be an existing .md file (${entry})`,
      });
      continue;
    }
    out.push(resolved);
  }
  return [...new Set(out)];
}

async function discoverExpertAgentPaths(pluginRoot: string): Promise<readonly string[]> {
  const agentsDir = path.join(pluginRoot, 'agents');
  if (!(await isDir(agentsDir))) return [];
  const entries = await readdir(agentsDir, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(agentsDir, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
  return Promise.all(paths.map((agentPath) => realpath(agentPath)));
}

function readExpertTeamInfo(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): PluginExpertTeamInfo | undefined {
  if (!isObject(raw)) {
    diagnostics.push({
      severity: 'error',
      message: '"teamInfo" is required for team experts',
    });
    return undefined;
  }
  const leadAgent = stringField(raw, 'leadAgent');
  const memberAgents = stringArrayField(raw, 'memberAgents');
  if (leadAgent === undefined || memberAgents === undefined) {
    diagnostics.push({
      severity: 'error',
      message: '"teamInfo" must define "leadAgent" and "memberAgents"',
    });
    return undefined;
  }
  return { leadAgent, memberAgents };
}

function readExpertMembers(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): readonly PluginExpertMember[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({ severity: 'error', message: '"members" must be an array' });
    return undefined;
  }
  const out: PluginExpertMember[] = [];
  raw.forEach((entry, index) => {
    if (!isObject(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `"members" entry ${index} must be an object`,
      });
      return;
    }
    const agent = stringField(entry, 'agent') ?? stringField(entry, 'id');
    const role = entry['role'];
    if (agent === undefined || (role !== 'lead' && role !== 'member')) {
      diagnostics.push({
        severity: 'error',
        message: `"members" entry ${index} must define "agent" or "id" and role "lead" or "member"`,
      });
      return;
    }
    out.push({
      agent,
      role,
      displayName: stringField(entry, 'displayName'),
      name: localizedTextField(entry, 'name'),
      profession: localizedTextField(entry, 'profession'),
      description: stringField(entry, 'description'),
      avatar: stringField(entry, 'avatar'),
    });
  });
  return out;
}

function localizedTextField(
  raw: Record<string, unknown>,
  key: string,
): PluginLocalizedText | undefined {
  const value = raw[key];
  if (typeof value === 'string') return value.trim() || undefined;
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].trim().length > 0 &&
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0,
    )
    .map(([locale, text]) => [locale.trim(), text.trim()] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function validateExpertTopology(input: {
  readonly type: PluginExpert['type'];
  readonly agentName: string;
  readonly agentPaths: readonly string[];
  readonly teamInfo: PluginExpertTeamInfo | undefined;
  readonly members: readonly PluginExpertMember[] | undefined;
  readonly diagnostics: PluginDiagnostic[];
}): void {
  const declaredAgentNames = new Set(
    input.agentPaths.map((agentPath) => path.basename(agentPath, path.extname(agentPath))),
  );
  if (!declaredAgentNames.has(input.agentName)) {
    input.diagnostics.push({
      severity: 'error',
      message: `"agentName" must reference one of the declared agent files (${input.agentName})`,
    });
  }
  if (input.type !== 'team' || input.teamInfo === undefined) return;
  if (input.teamInfo.leadAgent !== input.agentName) {
    input.diagnostics.push({
      severity: 'error',
      message: '"teamInfo.leadAgent" must equal "agentName"',
    });
  }
  if (input.teamInfo.memberAgents.includes(input.teamInfo.leadAgent)) {
    input.diagnostics.push({
      severity: 'error',
      message: '"teamInfo.memberAgents" must not include the lead agent',
    });
  }
  if (new Set(input.teamInfo.memberAgents).size !== input.teamInfo.memberAgents.length) {
    input.diagnostics.push({
      severity: 'error',
      message: '"teamInfo.memberAgents" must not contain duplicates',
    });
  }
  for (const member of input.teamInfo.memberAgents) {
    if (!declaredAgentNames.has(member)) {
      input.diagnostics.push({
        severity: 'error',
        message: `"teamInfo.memberAgents" references undeclared agent "${member}"`,
      });
    }
  }
  if (input.members === undefined) {
    input.diagnostics.push({
      severity: 'error',
      message: '"members" is required for team experts',
    });
    return;
  }
  const memberNames = input.members.map((member) => member.agent);
  if (new Set(memberNames).size !== memberNames.length) {
    input.diagnostics.push({ severity: 'error', message: '"members" must not contain duplicates' });
  }
  const leadMembers = input.members.filter((member) => member.role === 'lead');
  if (leadMembers.length !== 1 || leadMembers[0]?.agent !== input.teamInfo.leadAgent) {
    input.diagnostics.push({
      severity: 'error',
      message: '"members" must contain exactly one lead matching "teamInfo.leadAgent"',
    });
  }
  const expectedMembers = new Set([input.teamInfo.leadAgent, ...input.teamInfo.memberAgents]);
  for (const member of expectedMembers) {
    if (!memberNames.includes(member)) {
      input.diagnostics.push({
        severity: 'error',
        message: `"members" is missing declared team agent "${member}"`,
      });
    }
  }
  for (const member of memberNames) {
    if (!expectedMembers.has(member)) {
      input.diagnostics.push({
        severity: 'error',
        message: `"members" contains undeclared team agent "${member}"`,
      });
    }
  }
}

function recordUnsupportedRuntimeFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
      message: `"${field}" is present but not supported by Kimi plugins`,
    });
  }
}

async function resolveSkillsField(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'error', message: '"skills" must be a string or string[]' });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        message: `"skills" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute;
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        message: `"skills" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
        message: `"skills" path is not a directory (${entry})`,
      });
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}

async function resolvePluginPathField(input: {
  readonly pluginRoot: string;
  readonly field: string;
  readonly value: string;
  readonly diagnostics: PluginDiagnostic[];
  readonly severity?: PluginDiagnostic['severity'];
}): Promise<string | undefined> {
  const severity = input.severity ?? 'warn';
  if (!input.value.startsWith('./')) {
    input.diagnostics.push({
      severity,
      message: `"${input.field}" path must start with "./" (got "${input.value}")`,
    });
    return undefined;
  }
  const absolute = path.resolve(input.pluginRoot, input.value);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    real = absolute;
  }
  const rootReal = await realpath(input.pluginRoot).catch(() => input.pluginRoot);
  if (!isWithin(real, rootReal)) {
    input.diagnostics.push({
      severity,
      message: `"${input.field}" path resolves outside the plugin (${input.value})`,
    });
    return undefined;
  }
  return real;
}

function readSessionStart(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): PluginManifest['sessionStart'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"sessionStart" must be an object' });
    return undefined;
  }
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) {
    diagnostics.push({
      severity: 'warn',
      message: '"sessionStart.skill" is required when sessionStart is present',
    });
    return undefined;
  }
  return { skill };
}

async function readMcpServers(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<PluginManifest['mcpServers']> {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"mcpServers" must be an object' });
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({
        severity: 'warn',
        message: '"mcpServers" entries must have a non-empty name',
      });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid MCP server "${trimmedName}": ${parsed.error.message}`,
      });
      continue;
    }
    const normalized = await normalizePluginMcpServer({
      pluginRoot,
      name: trimmedName,
      config: parsed.data,
      diagnostics,
    });
    if (normalized !== undefined) out[trimmedName] = normalized;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function readHooks(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): readonly HookDefConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({ severity: 'warn', message: '"hooks" must be an array' });
    return undefined;
  }
  const out: HookDefConfig[] = [];
  raw.forEach((entry, i) => {
    const parsed = HookDefSchema.safeParse(entry);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid hook at index ${i}: ${parsed.error.message}`,
      });
    } else {
      out.push(parsed.data);
    }
  });
  return out.length === 0 ? undefined : out;
}

async function readCommands(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly PluginCommandEntry[] | undefined> {
  if (raw === undefined) return undefined;
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'warn', message: '"commands" must be a string or string[]' });
    return undefined;
  }

  const files: PluginCommandEntry[] = [];
  for (const entry of entries) {
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: 'commands',
      value: entry,
      diagnostics,
    });
    if (resolved === undefined) continue;
    if (await isDir(resolved)) {
      files.push(...(await listMarkdownFilesRecursive(resolved)));
    } else if ((await isFile(resolved)) && resolved.endsWith('.md')) {
      files.push({ path: resolved, name: commandNameFromFile(resolved, path.dirname(resolved)) });
    } else {
      diagnostics.push({
        severity: 'warn',
        message: `"commands" entry must be a directory or .md file (${entry})`,
      });
    }
  }
  return files.length === 0 ? undefined : files.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function listMarkdownFilesRecursive(root: string): Promise<readonly PluginCommandEntry[]> {
  const out: PluginCommandEntry[] = [];
  await walkMarkdown(root, root, out);
  return out;
}

async function walkMarkdown(
  root: string,
  dir: string,
  out: PluginCommandEntry[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ path: full, name: commandNameFromFile(full, root) });
    }
  }
}

function commandNameFromFile(file: string, root: string): string {
  const relative = path.relative(root, file).replace(/\.md$/i, '');
  return relative.split(path.sep).join('/');
}

async function normalizePluginMcpServer(input: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<McpServerConfig | undefined> {
  const { config } = input;
  if (config.transport === 'http' || config.transport === 'sse') return config;

  let command = config.command;
  if (command.startsWith('./')) {
    const resolvedCommand = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.command`,
      value: command,
      diagnostics: input.diagnostics,
    });
    if (resolvedCommand === undefined) return undefined;
    command = resolvedCommand;
  } else if (command.includes('/') || path.isAbsolute(command)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"mcpServers.${input.name}.command" must be a PATH command or start with "./"`,
    });
    return undefined;
  }

  let cwd = config.cwd;
  if (cwd !== undefined) {
    const resolvedCwd = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.cwd`,
      value: cwd,
      diagnostics: input.diagnostics,
    });
    if (resolvedCwd === undefined) return undefined;
    cwd = resolvedCwd;
  }

  return { ...config, command, cwd };
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(
  raw: unknown,
  manifest: Record<string, unknown>,
): PluginInterface | undefined {
  const nested = isObject(raw) ? raw : {};
  const out: PluginInterface = {
    displayName: stringField(nested, 'displayName') ?? stringField(manifest, 'displayName'),
    shortDescription:
      stringField(nested, 'shortDescription') ??
      stringField(manifest, 'displayDescription'),
    longDescription: stringField(nested, 'longDescription'),
    developerName: stringField(nested, 'developerName'),
    websiteURL: stringField(nested, 'websiteURL'),
  };
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
