import {
  ErrorCodes,
  KimiError,
  mapKlientError,
  type KimiErrorCode,
} from '#/sdk-errors';

const SDK_ERROR_CODES = new Set<string>(Object.values(ErrorCodes));

function isKimiErrorCode(value: unknown): value is KimiErrorCode {
  return typeof value === 'string' && SDK_ERROR_CODES.has(value);
}

export function mapV2BoundaryError(error: unknown): unknown {
  if (error instanceof KimiError) return error;
  const mappedKlientError = mapKlientError(error);
  if (mappedKlientError !== undefined) return mappedKlientError;

  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    const details =
      'details' in error &&
      error.details !== null &&
      typeof error.details === 'object' &&
      !Array.isArray(error.details)
        ? { ...error.details }
        : undefined;
    if (isKimiErrorCode(error.code)) {
      return new KimiError(error.code, error.message, { details, cause: error });
    }
    if (
      error.code === 'mcp_catalog.invalid' ||
      error.code === 'mcp_catalog.io_failed'
    ) {
      return new KimiError(ErrorCodes.CONFIG_INVALID, error.message, {
        details,
        cause: error,
      });
    }
    if (error.code === 'mcp_catalog.not_found') {
      return new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, error.message, {
        details,
        cause: error,
      });
    }
    if (error.code === 'mcp_catalog.duplicate') {
      return new KimiError(ErrorCodes.REQUEST_INVALID, error.message, {
        details,
        cause: error,
      });
    }
    if (error.code === 'session_store.invalid_turn_index') {
      return new KimiError(ErrorCodes.REQUEST_INVALID, error.message, {
        details,
        cause: error,
      });
    }
  }
  return error;
}
