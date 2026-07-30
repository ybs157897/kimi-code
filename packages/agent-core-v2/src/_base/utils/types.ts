/**
 * Promise-aware utility types for function and method signatures.
 */

export type Promisify<T> = [T] extends [Promise<any>] ? T : Promise<T>;
export type PromisifyMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promisify<Return>
    : never;
};

export type Promisable<T> = [T] extends [Promise<any>] ? T | Awaited<T> : T | Promise<T>;
export type PromisableMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promisable<Return>
    : never;
};

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
