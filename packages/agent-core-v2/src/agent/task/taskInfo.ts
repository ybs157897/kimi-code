/**
 * `task` domain (L5) — pure predicates and selection over `AgentTaskInfo`:
 * the terminal-status test (`isAgentTaskTerminal`), list filtering
 * (`shouldListTask`), and the restore merge that keeps the newer of two
 * restored infos (`newerRestoredTask`).
 */

import type { AgentTaskInfo, AgentTaskStatus } from './task';
import { TERMINAL_STATUSES } from './types';

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function shouldListTask(info: AgentTaskInfo, activeOnly: boolean): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}

export function newerRestoredTask(
  existing: AgentTaskInfo,
  loaded: AgentTaskInfo,
): AgentTaskInfo {
  const existingTerminal = isAgentTaskTerminal(existing.status);
  const loadedTerminal = isAgentTaskTerminal(loaded.status);
  if (existingTerminal && !loadedTerminal) return existing;
  if (!existingTerminal && loadedTerminal) return loaded;
  if (existing.endedAt !== null && loaded.endedAt !== null) {
    return loaded.endedAt >= existing.endedAt ? loaded : existing;
  }
  if (existing.endedAt !== null) return existing;
  if (loaded.endedAt !== null) return loaded;
  return loaded;
}
