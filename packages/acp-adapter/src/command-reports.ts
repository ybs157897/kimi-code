import { type AvailableCommand } from '@agentclientprotocol/sdk';
import {
  type BackgroundTaskInfo,
  type McpServerInfo,
  type SessionStatus,
  type SessionUsage,
} from '@moonshot-ai/kimi-code-sdk';

import { ACP_BUILTIN_SLASH_COMMANDS } from './builtin-commands';
import { type CompactionCompletedResult } from './session-types';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatHelpReport(commands: readonly AvailableCommand[]): string {
  const visibleCommands: readonly AvailableCommand[] =
    commands.length > 0 ? commands : ACP_BUILTIN_SLASH_COMMANDS;
  return [
    'Available ACP commands:',
    ...visibleCommands.map((command) => {
      const hint = command.input?.hint ? ` ${command.input.hint}` : '';
      return `- /${command.name}${hint} — ${command.description}`;
    }),
  ].join('\n');
}

export function formatStatusReport(status: SessionStatus): string {
  const maxTokens = status.maxContextTokens > 0 ? status.maxContextTokens.toLocaleString('en-US') : 'unknown';
  const usage = formatContextUsage(status.contextUsage);
  return [
    'Session status:',
    `- Model: ${status.model ?? '(not set)'}`,
    `- Thinking: ${status.thinkingEffort}`,
    `- Permission: ${status.permission}`,
    `- Plan mode: ${status.planMode ? 'on' : 'off'}`,
    `- Context: ${status.contextTokens.toLocaleString('en-US')} / ${maxTokens}${usage}`,
  ].join('\n');
}

export function formatUsageReport(usage: SessionUsage, status: SessionStatus): string {
  const lines = ['Session usage:'];
  if (usage.total !== undefined) {
    lines.push(`- Total: ${formatTokenUsage(usage.total)}`);
  }
  if (usage.currentTurn !== undefined) {
    lines.push(`- Current turn: ${formatTokenUsage(usage.currentTurn)}`);
  }
  for (const [model, modelUsage] of Object.entries(usage.byModel ?? {})) {
    lines.push(`- ${model}: ${formatTokenUsage(modelUsage)}`);
  }
  lines.push(
    `- Context: ${status.contextTokens.toLocaleString('en-US')} / ${status.maxContextTokens.toLocaleString('en-US')}${formatContextUsage(status.contextUsage)}`,
  );
  return lines.join('\n');
}

export function formatMcpReport(servers: readonly McpServerInfo[]): string {
  if (servers.length === 0) return 'No MCP servers are configured for this session.';
  return [
    `MCP servers (${servers.length}):`,
    ...servers.map((server) => {
      const base = `- ${server.name}: ${server.status} (${server.transport}, ${server.toolCount} tools)`;
      return server.error === undefined ? base : `${base}\n  Error: ${server.error}`;
    }),
  ].join('\n');
}

export function formatTasksReport(tasks: readonly BackgroundTaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks for this session.';
  return [
    `Background tasks (${tasks.length}):`,
    ...tasks.map((task) => {
      const parts = [`- ${task.taskId}: ${task.status}`, task.description];
      if (task.kind === 'process') parts.push(`command=${task.command}`);
      if (task.kind === 'agent' && task.subagentType !== undefined) parts.push(`subagent=${task.subagentType}`);
      if (task.stopReason !== undefined) parts.push(`reason=${task.stopReason}`);
      return parts.join(' · ');
    }),
  ].join('\n');
}

export function formatCompactionCompleted(result: CompactionCompletedResult): string {
  return [
    'Compaction completed.',
    `- Messages compacted: ${result.compactedCount.toLocaleString('en-US')}`,
    `- Tokens before: ${result.tokensBefore.toLocaleString('en-US')}`,
    `- Tokens after: ${result.tokensAfter.toLocaleString('en-US')}`,
  ].join('\n');
}

export function formatTokenUsage(usage: NonNullable<SessionUsage['total']>): string {
  return [
    `input ${usage.inputOther.toLocaleString('en-US')}`,
    `output ${usage.output.toLocaleString('en-US')}`,
    `cache read ${usage.inputCacheRead.toLocaleString('en-US')}`,
    `cache creation ${usage.inputCacheCreation.toLocaleString('en-US')}`,
  ].join(', ');
}

// agent-core emits `contextUsage` as a 0..1 fraction (`contextTokens /
// maxContextTokens` — see agent-core/src/agent/index.ts:419-422). It can
// briefly exceed 1.0 when a turn overflows the budget; we still surface
// that as ">100%" rather than collapsing back into 0..1.
export function formatContextUsage(contextUsage: number): string {
  if (!Number.isFinite(contextUsage) || contextUsage < 0) return '';
  return ` (${(contextUsage * 100).toFixed(1)}%)`;
}
