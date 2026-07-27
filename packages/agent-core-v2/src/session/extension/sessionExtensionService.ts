/**
 * `sessionExtension` domain (L3) — `ISessionExtensionService` implementation.
 *
 * Loads one workspace's extension snapshot through the App-scoped `extension`
 * loader, owns the live callback-bearing catalog for the Session, and exposes
 * commands plus explicit reload notifications. Reads workspace identity from
 * `sessionContext`. Bound at Session scope.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import type {
  ExtensionCommandDefinition,
  ExtensionLoadError,
  ExtensionLoadResult,
  LoadedExtension,
} from '#/app/extension/extension.types';
import { IExtensionLoaderService } from '#/app/extension/extensionLoader';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  type ExtensionReloadParticipant,
  type ExtensionReloadSummary,
  type ResolvedExtensionCommand,
  ISessionExtensionService,
} from './sessionExtension';

export class SessionExtensionService extends Disposable implements ISessionExtensionService {
  declare readonly _serviceBrand: undefined;

  private current: ExtensionLoadResult = { extensions: [], errors: [] };
  private readonly reloadParticipants = new Set<ExtensionReloadParticipant>();
  private readonly onDidReloadEmitter = this._register(new Emitter<ExtensionReloadSummary>());
  private operationTail: Promise<void> = Promise.resolve();

  readonly ready: Promise<void>;
  readonly onDidReload: Event<ExtensionReloadSummary> = this.onDidReloadEmitter.event;

  constructor(
    @IExtensionLoaderService private readonly loader: IExtensionLoaderService,
    @ISessionContext private readonly context: ISessionContext,
  ) {
    super();
    this.ready = this.enqueueLoad(false).then(() => undefined);
  }

  list(): readonly LoadedExtension[] {
    return [...this.current.extensions];
  }

  errors(): readonly ExtensionLoadError[] {
    return [...this.current.errors];
  }

  reload(): Promise<ExtensionReloadSummary> {
    return this.enqueueLoad(true);
  }

  registerReloadParticipant(participant: ExtensionReloadParticipant): IDisposable {
    this.reloadParticipants.add(participant);
    return toDisposable(() => {
      this.reloadParticipants.delete(participant);
    });
  }

  async listCommands(): Promise<readonly ExtensionCommandDefinition[]> {
    await this.ready;
    const commands: ExtensionCommandDefinition[] = [];
    for (const extension of this.current.extensions) {
      for (const command of extension.commands.values()) {
        commands.push({
          extensionId: extension.id,
          name: command.name,
          description: command.description,
        });
      }
    }
    return commands;
  }

  resolveCommand(extensionId: string, name: string): ResolvedExtensionCommand | undefined {
    const extension = this.current.extensions.find((candidate) => candidate.id === extensionId);
    const command = extension?.commands.get(name);
    if (extension === undefined || command === undefined) return undefined;
    return {
      extensionId,
      extensionPath: extension.path,
      command,
    };
  }

  private enqueueLoad(notify: boolean): Promise<ExtensionReloadSummary> {
    const operation = this.operationTail.then(() => this.load(notify));
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async load(notify: boolean): Promise<ExtensionReloadSummary> {
    const participants = [...this.reloadParticipants];
    if (notify) {
      for (const participant of participants) await participant.prepareForReload();
    }
    this.current = await this.loader.load({ cwd: this.context.cwd });
    if (notify) {
      for (const participant of participants) await participant.activateReloadedCatalog();
    }
    const summary = {
      active: this.current.extensions.map((extension) => extension.resolvedPath),
      errors: [...this.current.errors],
    };
    if (notify) this.onDidReloadEmitter.fire(summary);
    return summary;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExtensionService,
  SessionExtensionService,
  ScopeActivation.OnScopeCreated,
  'sessionExtension',
);
