/**
 * Pure string/number formatting helpers used by the tool-call component
 * (tokens, byte sizes, elapsed time, subagent labels, failure messages).
 */

import type { AgentTokenUsage } from '#/tui/runtime/session-control-port';
import { formatTokenCount } from '#/utils/usage/usage-format';

export function backgroundFailureMessage(
  status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost' | undefined,
): string | undefined {
  switch (status) {
    case 'lost':
      return 'Background agent lost (session restarted before completion)';
    case 'killed':
      return 'Background agent killed';
    case 'timed_out':
      return 'Background agent timed out';
    case 'failed':
      return 'Background agent failed';
    case 'completed':
    case undefined:
      return undefined;
  }
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function formatSubagentContextTokens(contextTokens: number | undefined): string | undefined {
  if (contextTokens === undefined || contextTokens <= 0) return undefined;
  return `${formatTokenCount(contextTokens)} tok`;
}

function usageInputTotal(usage: Partial<AgentTokenUsage>): number {
  return (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
}

export function usageTotal(usage: Partial<AgentTokenUsage> | undefined): number {
  if (usage === undefined) return 0;
  return usageInputTotal(usage) + (usage.output ?? 0);
}

export function formatSubagentTokens(
  usage: Partial<AgentTokenUsage> | undefined,
): string | undefined {
  const total = usageTotal(usage);
  if (total <= 0) return undefined;
  return `${formatTokenCount(total)} tok`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

export function formatSubagentLabel(agentName: string | undefined): string {
  const raw = agentName?.trim();
  if (raw === undefined || raw.length === 0) return 'SubAgent';
  const label = raw
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  if (/\bagent$/i.test(label)) return label;
  return `${label} Agent`;
}

export function tailNonEmptyLines(text: string, maxLines: number): string[] {
  if (text.length === 0) return [];
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);
}

export function formatTokens(n: number): string {
  return `${formatTokenCount(n)} tok`;
}
