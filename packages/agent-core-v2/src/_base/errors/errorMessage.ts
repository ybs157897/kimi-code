/**
 * Render thrown values as human-readable lines for logs and CLI output.
 */

import { isCodedError } from './serialize';

/**
 * Minimal error-message extraction: `Error.message` for Error instances,
 * `String(error)` for everything else. Use {@link toErrorMessage} when you
 * need coded-error formatting, verbose cause chains, or JSON fallback.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toErrorMessage(error: unknown, verbose = false): string {
  if (isCodedError(error)) {
    const base = `[${error.code}] ${error.message}`;
    return verbose && error.details ? `${base} ${JSON.stringify(error.details)}` : base;
  }
  if (error instanceof Error) {
    const base = error.message || error.name;
    if (verbose && error.cause !== undefined) {
      return `${base} (caused by: ${toErrorMessage(error.cause)})`;
    }
    return base;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
