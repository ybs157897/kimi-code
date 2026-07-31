/**
 * Extract agent-swarm items, resume markers, descriptions, and prompt
 * templates from full or streaming tool-call arguments.
 */

import { RESUMED_ITEM_LABEL } from './constants';
import { countPartialJsonObjectEntries, parsePartialJsonString } from './partial-json';

export function agentSwarmItemsFromArgs(args: Record<string, unknown>): string[] {
  const items = args['items'];
  if (!Array.isArray(items)) return [];
  return items.map(String);
}

export function agentSwarmResumeItemsFromArgs(args: Record<string, unknown>): string[] {
  const resumeAgentIds = args['resume_agent_ids'];
  if (
    typeof resumeAgentIds !== 'object' ||
    resumeAgentIds === null ||
    Array.isArray(resumeAgentIds)
  ) {
    return [];
  }
  return Object.keys(resumeAgentIds).map(() => RESUMED_ITEM_LABEL);
}

export function agentSwarmPartialItemsCountFromArguments(argumentsText: string): number {
  return agentSwarmPartialItemsFromArguments(argumentsText).length;
}

export function agentSwarmWorkItemsStartedFromArguments(argumentsText: string): boolean {
  return /"items"\s*:/.test(argumentsText) || /"resume_agent_ids"\s*:/.test(argumentsText);
}

export function agentSwarmPartialItemsFromArguments(argumentsText: string): string[] {
  const match = /"items"\s*:\s*\[/.exec(argumentsText);
  if (match === null) return [];
  const items: string[] = [];
  for (let i = match.index + match[0].length; i < argumentsText.length; i += 1) {
    const ch = argumentsText[i];
    if (ch === ']') return items;
    if (ch !== '"') continue;

    const parsed = parsePartialJsonString(argumentsText, i + 1);
    items.push(parsed.value);
    if (parsed.closed) {
      i = parsed.nextIndex;
      continue;
    }
    return items;
  }
  return items;
}

export function agentSwarmPartialResumeItemsFromArguments(argumentsText: string): string[] {
  const match = /"resume_agent_ids"\s*:\s*\{/.exec(argumentsText);
  if (match === null) return [];
  return Array.from(
    { length: countPartialJsonObjectEntries(argumentsText, match.index + match[0].length) },
    () => RESUMED_ITEM_LABEL,
  );
}

export function agentSwarmDescriptionFromArgs(args: Record<string, unknown>): string {
  const description = args['description'];
  return typeof description === 'string' ? description : '';
}

export function agentSwarmPromptTemplateFromArgs(args: Record<string, unknown>): string {
  const promptTemplate = args['prompt_template'];
  return typeof promptTemplate === 'string' ? promptTemplate : '';
}

export function agentSwarmPartialPromptTemplateFromArguments(argumentsText: string): string {
  const match = /"prompt_template"\s*:\s*"/.exec(argumentsText);
  if (match === null) return '';
  return parsePartialJsonString(argumentsText, match.index + match[0].length).value;
}
