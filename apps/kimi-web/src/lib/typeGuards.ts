// apps/kimi-web/src/lib/typeGuards.ts
// Shared runtime type guards for the web application.

/**
 * Runtime type guard: true when `value` is a plain object (not null, not an
 * array). Use as a narrowing predicate before indexing into unknown JSON.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
