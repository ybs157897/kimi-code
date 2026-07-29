/**
 * `mcpCatalog` domain (L3) — App-scoped MCP server catalog CRUD contract.
 *
 * Defines `IMcpCatalogService` for managing the user-level MCP server catalog
 * (the `mcp.json` file at the Kimi home directory). Read merges user, project-
 * root, and project-level files (through the existing `mcp` config loader);
 * write targets the user file only. Bound at App scope.
 */

import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface McpCatalogEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: 'user';
}

export interface IMcpCatalogService {
  readonly _serviceBrand: undefined;

  /** List every user-level catalog entry. */
  list(): Promise<readonly McpCatalogEntry[]>;

  /** Get a single user-level entry by name. */
  get(name: string): Promise<McpCatalogEntry | undefined>;

  /** Add a new server to the user catalog. Throws on duplicate name. */
  add(name: string, config: McpServerConfig): Promise<McpCatalogEntry>;

  /** Update an existing server in the user catalog. Throws on not-found. */
  update(name: string, config: McpServerConfig): Promise<McpCatalogEntry>;

  /** Rename a server. Throws when source is not-found or target exists. */
  rename(oldName: string, newName: string): Promise<McpCatalogEntry>;

  /** Remove a server from the user catalog. Throws on not-found. */
  remove(name: string): Promise<void>;

  /** Remove all servers from the user catalog. */
  reset(): Promise<void>;
}

export const IMcpCatalogService: ServiceIdentifier<IMcpCatalogService> =
  createDecorator<IMcpCatalogService>('mcpCatalogService');
