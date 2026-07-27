/**
 * `agentExtension` domain (L4) — Agent-scope code extension runtime contract.
 *
 * Defines main-agent activation and extension slash-command execution, plus
 * the user-facing notice event emitted by `ExtensionContext.notify`. Bound at
 * Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ActivateExtensionCommandInput {
  readonly extensionId: string;
  readonly name: string;
  readonly args?: string;
}

export interface ExtensionNoticeEvent {
  readonly type: 'extension.notice';
  readonly message: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'extension.notice': ExtensionNoticeEvent;
  }
}

export interface IAgentExtensionService {
  readonly _serviceBrand: undefined;

  activate(): Promise<void>;
  shutdown(): Promise<void>;
  activateCommand(input: ActivateExtensionCommandInput): Promise<boolean>;
}

export const IAgentExtensionService: ServiceIdentifier<IAgentExtensionService> =
  createDecorator<IAgentExtensionService>('agentExtensionService');
