import type { AvailableCommand } from '@agentclientprotocol/sdk';

import type { IAcpSessionHost } from './iacp-session-host';

/**
 * Per-session snapshot returned by the {@link AcpServer} caller's
 * `slashCommands` resolver. Carries both what gets advertised in the
 * `available_commands_update` push and the `skillCommandMap` that
 * {@link AcpSession.prompt} consults to intercept `/skill:<name>`
 * inputs and route them through the session host's skill activation port.
 *
 * `skillCommandMap` is optional for backward compatibility: callers
 * that pre-date slash-command routing (or that only advertise builtin
 * commands) can omit it and get the previous "always passthrough"
 * behavior.
 */
export interface SlashCommandsSnapshot {
  readonly commands: ReadonlyArray<AvailableCommand>;
  readonly skillCommandMap?: ReadonlyMap<string, string>;
}

export type SlashCommandsResolver =
  | ReadonlyArray<AvailableCommand>
  | SlashCommandsSnapshot
  | ((
      session: IAcpSessionHost,
    ) =>
      | Promise<ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot>
      | ReadonlyArray<AvailableCommand>
      | SlashCommandsSnapshot);

export interface ResolvedSlashCommands {
  readonly commands: ReadonlyArray<AvailableCommand>;
  readonly skillCommandMap: ReadonlyMap<string, string>;
}

export function toResolvedSlashCommands(
  input: ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot,
): ResolvedSlashCommands {
  if (Array.isArray(input)) {
    return { commands: input, skillCommandMap: new Map() };
  }
  const snap = input as SlashCommandsSnapshot;
  return {
    commands: snap.commands,
    skillCommandMap: snap.skillCommandMap ?? new Map(),
  };
}
