// apps/kimi-web/src/api/desktop/mockHelpers.ts
// Pure helpers for the browser dev mock bridge (mock.ts): timing / key /
// chunking utilities, the coded envelope error, provider-input parsing, and
// the agent_config patch applied by create/update session.

import { isRecord } from '../../lib/typeGuards';
import type { WireSession } from '../daemon/wire';
import type { MockProviderInput } from './mockTypes';

/**
 * A coded product failure the dispatch wrapper serializes into a kap-server
 * error envelope (frozen contract E), so the desktop client's `call` surfaces
 * the same code/msg it would get from the real sidecar.
 */
export class MockEnvelopeError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
  ) {
    super(msg);
    this.name = 'MockEnvelopeError';
  }
}

export function mockEnvelopeError(code: number, msg: string): MockEnvelopeError {
  return new MockEnvelopeError(code, msg);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function turnKey(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

/** Slice 6 terminal attachment key (mirrors the Go shell's map key). */
export function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export function mockProviderInput(raw: unknown, fallbackId?: string): MockProviderInput {
  if (!isRecord(raw)) throw new Error('provider input must be an object');
  const id = requireMockString(raw['new_id'] ?? raw['id'] ?? fallbackId, 'provider id');
  const type = requireMockString(raw['type'], 'provider type');
  if (!Array.isArray(raw['models']) || raw['models'].length === 0) {
    throw new Error('provider must define at least one model');
  }
  return {
    id,
    type,
    apiKey:
      Object.prototype.hasOwnProperty.call(raw, 'api_key')
        ? optionalMockString(raw['api_key'])
        : undefined,
    baseUrl: optionalMockString(raw['base_url']),
    defaultModel: optionalMockString(raw['default_model']),
    models: raw['models'].map((value) => {
      if (!isRecord(value)) throw new Error('provider model must be an object');
      const maxContextSize = value['max_context_size'];
      if (typeof maxContextSize !== 'number' || !Number.isFinite(maxContextSize)) {
        throw new Error('provider model context size must be a number');
      }
      return {
        model: requireMockString(value['model'], 'model name'),
        displayName: optionalMockString(value['display_name']),
        maxContextSize,
      };
    }),
  };
}

export function requireMockString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

export function optionalMockString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Mutate a session's agent_config from a POST /profile (or create) body. */
export function applyMockAgentConfig(
  target: WireSession['agent_config'],
  patch: Record<string, unknown>,
): void {
  if (typeof patch['model'] === 'string') target.model = patch['model'];
  if (typeof patch['thinking'] === 'string') target.thinking = patch['thinking'];
  if (typeof patch['permission_mode'] === 'string') {
    target.permission_mode = patch['permission_mode'];
  }
  if (typeof patch['plan_mode'] === 'boolean') target.plan_mode = patch['plan_mode'];
  if (typeof patch['swarm_mode'] === 'boolean') target.swarm_mode = patch['swarm_mode'];
  if (typeof patch['goal_objective'] === 'string') {
    target.goal_objective = patch['goal_objective'];
  }
  if (
    patch['goal_control'] === 'pause' ||
    patch['goal_control'] === 'resume' ||
    patch['goal_control'] === 'cancel'
  ) {
    target.goal_control = patch['goal_control'];
  }
}
