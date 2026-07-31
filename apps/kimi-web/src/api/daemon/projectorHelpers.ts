// apps/kimi-web/src/api/daemon/projectorHelpers.ts
// Internal helpers shared by the agent event projector modules.

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function ulid(prefix = 'msg_'): string {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${t}${r}`;
}

/** Normalise the raw token usage shape emitted by agent-core. */
export function normalizeUsage(raw: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
} {
  if (!raw || typeof raw !== 'object') {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  }
  const u = raw as Record<string, number | undefined>;
  return {
    input: u['inputOther'] ?? u['input_tokens'] ?? 0,
    output: u['output'] ?? u['output_tokens'] ?? 0,
    cacheRead: u['inputCacheRead'] ?? u['cache_read_input_tokens'] ?? 0,
    cacheCreate: u['inputCacheCreation'] ?? u['cache_creation_input_tokens'] ?? 0,
  };
}

export function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function nullableNumberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
