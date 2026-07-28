/**
 * `tool` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const ToolErrors = {
  codes: {
    PATH_OUTSIDE_WORKSPACE: 'path.outside_workspace',
    PATH_SENSITIVE: 'path.sensitive',
    PATH_INVALID: 'path.invalid',
  },
  info: {
    'path.outside_workspace': {
      title: 'Path outside workspace',
      retryable: false,
      public: true,
      action: 'Use a path inside the workspace, or allow absolute paths outside it.',
    },
    'path.sensitive': {
      title: 'Sensitive path',
      retryable: false,
      public: true,
      action: 'Avoid credentials, keys, and other sensitive files.',
    },
    'path.invalid': {
      title: 'Invalid path',
      retryable: false,
      public: true,
      action: 'Provide a valid path.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ToolErrors);

export type ToolErrorCode = (typeof ToolErrors.codes)[keyof typeof ToolErrors.codes];

export class ToolError extends Error2 {
  constructor(code: ToolErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'ToolError';
  }
}
