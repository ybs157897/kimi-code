/**
 * `sessionExtension` domain (L3) — Session-scope extension catalog contract.
 *
 * Defines the current workspace's loaded extensions, diagnostics, contributed
 * commands, and explicit reload event. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type {
  ExtensionCommand,
  ExtensionCommandDefinition,
  ExtensionLoadError,
  LoadedExtension,
} from '#/app/extension/extension.types';

export interface ExtensionReloadSummary {
  readonly active: readonly string[];
  readonly errors: readonly ExtensionLoadError[];
}

export interface ResolvedExtensionCommand {
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly command: ExtensionCommand;
}

export interface ExtensionReloadParticipant {
  prepareForReload(): Promise<void>;
  activateReloadedCatalog(): Promise<void>;
}

export interface ISessionExtensionService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidReload: Event<ExtensionReloadSummary>;

  list(): readonly LoadedExtension[];
  errors(): readonly ExtensionLoadError[];
  reload(): Promise<ExtensionReloadSummary>;
  registerReloadParticipant(participant: ExtensionReloadParticipant): IDisposable;
  listCommands(): Promise<readonly ExtensionCommandDefinition[]>;
  resolveCommand(extensionId: string, name: string): ResolvedExtensionCommand | undefined;
}

export const ISessionExtensionService: ServiceIdentifier<ISessionExtensionService> =
  createDecorator<ISessionExtensionService>('sessionExtensionService');
