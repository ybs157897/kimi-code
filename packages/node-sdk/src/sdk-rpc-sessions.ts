import { join, resolve } from 'node:path';

import { ErrorCodes, KimiError } from '#/sdk-errors';
import type { IndexedSession, Klient } from '#/sdk-rpc-types';
import type { JsonObject, JsonValue, SessionSummary } from '#/types';

export async function resolveWorkspaceIds(
  klient: Klient,
  workDir: string,
): Promise<readonly string[]> {
  const workspaces = await klient.global.workspaces.list();
  return workspaces
    .filter((workspace) => resolve(workspace.root) === workDir)
    .map((workspace) => workspace.id);
}

export async function sessionBelongsToWorkDir(
  klient: Klient,
  summary: IndexedSession,
  workDir: string,
): Promise<boolean> {
  if (summary.cwd !== undefined) return resolve(summary.cwd) === workDir;
  const workspace = await klient.global.workspaces.get(summary.workspaceId);
  return workspace !== undefined && resolve(workspace.root) === workDir;
}

export async function toSessionSummary(
  klient: Klient,
  summary: IndexedSession,
  additionalDirs?: readonly string[],
): Promise<SessionSummary> {
  const [environment, workspace] = await Promise.all([
    klient.global.env(),
    summary.cwd === undefined
      ? klient.global.workspaces.get(summary.workspaceId)
      : Promise.resolve(undefined),
  ]);
  const workDir = summary.cwd ?? workspace?.root;
  if (workDir === undefined) {
    throw new KimiError(
      ErrorCodes.SESSION_STATE_INVALID,
      `Session "${summary.id}" has no workspace root.`,
    );
  }

  return {
    id: summary.id,
    title: summary.title,
    lastPrompt: summary.lastPrompt,
    workDir,
    sessionDir: join(environment.sessionsDir, summary.workspaceId, summary.id),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
    metadata: toJsonObject(summary.custom),
    additionalDirs,
  };
}

function toJsonObject(value: Readonly<Record<string, unknown>> | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value) || Array.isArray(value)) {
    throw new KimiError(
      ErrorCodes.SESSION_STATE_INVALID,
      'Session metadata is not JSON-serializable.',
    );
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}
