/**
 * `rpc` domain (L7) — Agent-scoped wire facade contract.
 *
 * Defines the implemented `IAgentRPCService` consumed by edge adapters and
 * Klient. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { PromisableMethods } from '#/_base/utils/types';

import type { AgentAPI } from './core-api';

export interface IAgentRPCService extends PromisableMethods<AgentAPI> {
  readonly _serviceBrand: undefined;
}

export const IAgentRPCService =
  createDecorator<IAgentRPCService>('agentRPCService');
