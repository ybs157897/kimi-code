// apps/kimi-web/src/api/desktop/mockTypes.ts
// Internal state types for the browser dev mock bridge (mock.ts): active-turn
// bookkeeping, the per-session product stream, and the mock provider record /
// input shapes.

import type { WireEvent, WireProvider } from '../daemon/wire';

export interface ActiveTurn {
  turnId: number;
  timers: ReturnType<typeof setTimeout>[];
}

/** Per-session product stream state (epoch/seq/journal + subscription gate). */
export interface MockProductStream {
  epoch: string;
  seq: number;
  journal: Array<{ seq: number; event: WireEvent }>;
  subscribed: boolean;
}

export interface MockProviderRecord extends WireProvider {
  api_key?: string;
}

export interface MockProviderModelInput {
  model: string;
  displayName?: string;
  maxContextSize: number;
}

export interface MockProviderInput {
  id: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models: MockProviderModelInput[];
}
