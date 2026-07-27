/**
 * `replayView` domain (L5) — complete read-only Agent replay snapshot contract.
 *
 * Exposes `IAgentReplayView.read()` for consumers that need one wire-friendly
 * resume snapshot without borrowing scoped services or reconstructing domain
 * state at an edge. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ResumedAgentState } from '#/agent/replayBuilder/types';

export interface IAgentReplayView {
  readonly _serviceBrand: undefined;

  read(): Promise<ResumedAgentState>;
}

export const IAgentReplayView: ServiceIdentifier<IAgentReplayView> =
  createDecorator<IAgentReplayView>('agentReplayView');
