/**
 * `mcpCatalog` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const McpCatalogErrors = {
  codes: {
    MCP_CATALOG_DUPLICATE: 'mcp_catalog.duplicate',
    MCP_CATALOG_NOT_FOUND: 'mcp_catalog.not_found',
    MCP_CATALOG_IO_FAILED: 'mcp_catalog.io_failed',
    MCP_CATALOG_INVALID: 'mcp_catalog.invalid',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(McpCatalogErrors);
