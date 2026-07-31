import { resolve } from 'node:path';

import { ErrorCodes, KimiError } from '#/sdk-errors';
import type { CoreOverrides } from '#/sdk-rpc-types';
import type { CreateSessionOptions, KimiConfig } from '#/types';

export function parseExtensionCommandName(name: string): {
  readonly extensionId: string;
  readonly name: string;
} {
  const separator = name.indexOf(':');
  const extensionId = separator < 0 ? '' : name.slice(0, separator).trim();
  const commandName = separator < 0 ? '' : name.slice(separator + 1).trim();
  if (extensionId.length === 0 || commandName.length === 0) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      'Extension command name must use the "<extensionId>:<commandName>" form.',
      { details: { name } },
    );
  }
  return { extensionId, name: commandName };
}

export function normalizeWorkDir(workDir: string): string {
  if (typeof workDir !== 'string' || workDir.trim().length === 0) {
    throw new KimiError(
      ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
      'Session workDir is required.',
    );
  }
  return resolve(workDir.trim());
}

export function normalizeWorkspaceSkillsWorkDir(workDir: string): string {
  if (typeof workDir !== 'string' || workDir.trim().length === 0) {
    throw new KimiError(
      ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
      'listWorkspaceSkills requires workDir',
    );
  }
  return resolve(workDir.trim());
}

export function normalizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string') {
    throw new KimiError(ErrorCodes.SESSION_ID_REQUIRED, 'Session id is required.');
  }
  const normalized = sessionId.trim();
  if (normalized.length === 0) {
    throw new KimiError(ErrorCodes.SESSION_ID_EMPTY, 'Session id cannot be empty.');
  }
  return normalized;
}

export function normalizeSessionTitle(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty.');
  }
  return title.trim();
}

export function normalizeOptionalSessionTitle(title: string | undefined): string | undefined {
  return title === undefined ? undefined : normalizeSessionTitle(title);
}

export function normalizeAgentId(agentId: string): string {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agent id cannot be empty.');
  }
  return agentId.trim();
}

export function normalizeNamedResource(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, `${label} cannot be empty.`);
  }
  return value.trim();
}

export function normalizeMcpServerName(name: string): string {
  return normalizeNamedResource(name, 'MCP server name');
}

export function sessionNotFound(sessionId: string): KimiError {
  return new KimiError(
    ErrorCodes.SESSION_NOT_FOUND,
    `Session "${sessionId}" does not exist.`,
    { details: { sessionId } },
  );
}

export function imageConfig(
  config: KimiConfig,
): { readonly maxEdgePx?: number; readonly readByteBudget?: number } | undefined {
  const image = config['image'];
  if (typeof image !== 'object' || image === null || Array.isArray(image)) return undefined;
  const values = image as Readonly<Record<string, unknown>>;
  const maxEdgePx = positiveInteger(values['maxEdgePx']);
  const readByteBudget = positiveInteger(values['readByteBudget']);
  if (maxEdgePx === undefined && readByteBudget === undefined) return undefined;
  return { maxEdgePx, readByteBudget };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function assertNoKaosOverrides(overrides: CoreOverrides): void {
  if (overrides.kaos === undefined && overrides.persistenceKaos === undefined) return;
  throw unsupportedV2Option(
    'custom Kaos session overrides',
    'The v2 Klient session lifecycle does not expose host Kaos injection.',
  );
}

export function assertSupportedCreateSessionOptions(input: CreateSessionOptions): void {
  if (input.drainAgentTasksOnStop !== true) return;
  throw unsupportedV2Option(
    'drainAgentTasksOnStop',
    'v2 does not expose the legacy pre-turn-completion subagent drain hook; use the print background policy after turn completion.',
  );
}

export function unsupportedV2Option(option: string, reason: string): KimiError {
  return new KimiError(
    ErrorCodes.NOT_IMPLEMENTED,
    `The "${option}" compatibility option is not supported by the v2-backed root SDK. ${reason}`,
    { details: { option } },
  );
}
