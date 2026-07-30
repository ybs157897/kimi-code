// apps/kimi-code/src/utils/type-guards.ts
// Shared runtime type guards for the CLI / TUI application.

/**
 * Runtime type guard: true when `value` is a plain object (not null, not an
 * array). Use as a narrowing predicate before indexing into unknown JSON.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime type guard: true when `value` is a non-empty string. Use as a
 * narrowing predicate before using unknown values as string identifiers.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
