/**
 * Tool argument display: pick and format the "key" argument shown in a tool
 * header, plus the group-row latest-activity line built from those args.
 */

import { isAbsolute, relative, sep } from 'node:path';

import type { FinishedSubCall, OngoingSubCall } from './types';

const MAX_ARG_LENGTH = 60;

const PATH_KEYS = new Set(['path', 'file_path']);

function truncateArgValue(key: string, value: string): string {
  if (value.length <= MAX_ARG_LENGTH) return value;
  if (PATH_KEYS.has(key)) {
    // Preserve the tail (filename) — drop the prefix so the user can
    // still tell which file is being touched.
    return '…' + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 3) + '...';
}

export function makeWorkspaceRelativePath(filePath: string, workspaceDir: string | undefined): string {
  if (workspaceDir === undefined || workspaceDir.length === 0 || !isAbsolute(filePath)) {
    return filePath;
  }
  const relativePath = relative(workspaceDir, filePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return filePath;
  }
  return relativePath;
}

function formatKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  const displayValue =
    toolName === 'Read' && PATH_KEYS.has(key)
      ? makeWorkspaceRelativePath(value, workspaceDir)
      : value;
  return truncateArgValue(key, displayValue);
}

export function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    // Prefer the short `description` so the header preview never spills a
    // multi-line `prompt` into the TUI chrome.
    Agent: ['description', 'prompt'],
  };

  // Glob: concatenate multiple args into a single summary so the header
  // shows pattern, optional explicit path, and ignored-file inclusion.
  if (toolName === 'Glob') {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0) return null;
    let summary = pattern;
    const path = args['path'];
    if (typeof path === 'string' && path.length > 0) {
      summary += ` · ${makeWorkspaceRelativePath(path, workspaceDir)}`;
    }
    if (args['include_ignored'] === true) {
      summary += ' · include ignored';
    }
    return truncateArgValue('pattern', summary);
  }

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      const displayValue =
        toolName === 'Bash' && val.includes('\n') ? `${firstLine}…` : firstLine;
      return formatKeyArgument(toolName, key, displayValue, workspaceDir);
    }
  }
  return null;
}

/**
 * Computes the second-level "latest activity" line for group rows:
 *   1. latest ongoing sub-tool (`Using {name} ({keyArg})`)
 *   2. latest finished sub-tool (`Used {name} ({keyArg})`)
 *   3. last non-empty line from accumulated subagent text
 */
export function computeLatestActivity(
  ongoing: ReadonlyMap<string, OngoingSubCall>,
  finished: readonly FinishedSubCall[],
  text: string,
  workspaceDir?: string,
): string | undefined {
  if (ongoing.size > 0) {
    const lastOngoing = [...ongoing.values()].at(-1);
    if (lastOngoing !== undefined) {
      return formatActivityLine('Using', lastOngoing.name, lastOngoing.args, workspaceDir);
    }
  }
  if (finished.length > 0) {
    const last = finished.at(-1);
    if (last !== undefined) {
      return formatActivityLine('Used', last.name, last.args, workspaceDir);
    }
  }
  if (text.length > 0) {
    const tail = text
      .split('\n')
      .toReversed()
      .find((l) => l.trim().length > 0);
    if (tail !== undefined) return tail.trim();
  }
  return undefined;
}

function formatActivityLine(
  verb: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string {
  const keyArg = extractKeyArgument(toolName, args, workspaceDir);
  return keyArg ? `${verb} ${toolName} (${keyArg})` : `${verb} ${toolName}`;
}
