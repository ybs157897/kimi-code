/**
 * `contextCommand` domain error codes — context import validation and guard failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ContextCommandErrors = {
  codes: {
    CONTEXT_IMPORT_EMPTY: 'context_import.empty',
    CONTEXT_IMPORT_INVALID: 'context_import.invalid',
    CONTEXT_IMPORT_OVERFLOW: 'context_import.overflow',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ContextCommandErrors);
