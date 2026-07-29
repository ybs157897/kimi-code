/**
 * `mcpCatalog` domain (L3) — `IMcpCatalogService` implementation.
 *
 * Reads and writes the user-level `mcp.json` file (`<homeDir>/mcp.json`).
 * Reads use the existing `mcp` config loader; writes preserve unknown
 * top-level fields (as required by the MCP config contract). Logs through
 * `log`. Bound at App scope.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';
import { z } from 'zod';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService, resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import { Error2 } from '#/_base/errors/errors';
import { McpServerConfigSchema, type McpServerConfig } from '#/agent/mcp/config-schema';

import { McpCatalogErrors } from './errors';
import {
  type IMcpCatalogService,
  type McpCatalogEntry,
  IMcpCatalogService as IMcpCatalogServiceToken,
} from './mcpCatalog';

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
}).passthrough();

type McpJsonFile = z.infer<typeof McpJsonFileSchema>;

export class McpCatalogService extends Disposable implements IMcpCatalogService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  private get userPath(): string {
    return join(resolveKimiHome(this.bootstrap.homeDir), 'mcp.json');
  }

  async list(): Promise<readonly McpCatalogEntry[]> {
    const file = await this.readUserFile();
    return Object.entries(file.mcpServers).map(([name, config]) => ({
      name,
      config,
      source: 'user' as const,
    }));
  }

  async get(name: string): Promise<McpCatalogEntry | undefined> {
    const file = await this.readUserFile();
    const config = file.mcpServers[name];
    if (config === undefined) return undefined;
    return { name, config, source: 'user' };
  }

  async add(name: string, config: McpServerConfig): Promise<McpCatalogEntry> {
    const file = await this.readUserFile();
    if (file.mcpServers[name] !== undefined) {
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_DUPLICATE,
        `MCP server "${name}" already exists`,
        { details: { server_name: name } },
      );
    }
    file.mcpServers[name] = config;
    await this.writeUserFile(file);
    return { name, config, source: 'user' };
  }

  async update(name: string, config: McpServerConfig): Promise<McpCatalogEntry> {
    const file = await this.readUserFile();
    if (file.mcpServers[name] === undefined) {
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_NOT_FOUND,
        `MCP server "${name}" not found`,
        { details: { server_name: name } },
      );
    }
    file.mcpServers[name] = config;
    await this.writeUserFile(file);
    return { name, config, source: 'user' };
  }

  async rename(oldName: string, newName: string): Promise<McpCatalogEntry> {
    const file = await this.readUserFile();
    const config = file.mcpServers[oldName];
    if (config === undefined) {
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_NOT_FOUND,
        `MCP server "${oldName}" not found`,
        { details: { server_name: oldName } },
      );
    }
    if (file.mcpServers[newName] !== undefined) {
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_DUPLICATE,
        `Cannot rename to "${newName}" — that name already exists`,
        { details: { server_name: newName } },
      );
    }
    delete file.mcpServers[oldName];
    file.mcpServers[newName] = config;
    await this.writeUserFile(file);
    return { name: newName, config, source: 'user' };
  }

  async remove(name: string): Promise<void> {
    const file = await this.readUserFile();
    if (file.mcpServers[name] === undefined) {
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_NOT_FOUND,
        `MCP server "${name}" not found`,
        { details: { server_name: name } },
      );
    }
    delete file.mcpServers[name];
    await this.writeUserFile(file);
  }

  async reset(): Promise<void> {
    await this.writeUserFile({ mcpServers: {} });
  }

  private async readUserFile(): Promise<McpJsonFile> {
    try {
      const text = await readFile(this.userPath, 'utf-8');
      if (text.trim().length === 0) return { mcpServers: {} };
      const data = JSON.parse(text);
      return McpJsonFileSchema.parse(data);
    } catch (error: unknown) {
      if (isFileNotFound(error)) return { mcpServers: {} };
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_IO_FAILED,
        `Failed to read MCP catalog: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  private async writeUserFile(file: McpJsonFile): Promise<void> {
    try {
      const text = JSON.stringify(file, null, 2) + '\n';
      await mkdir(dirname(this.userPath), { recursive: true });
      await writeFile(this.userPath, text, 'utf-8');
    } catch (error: unknown) {
      throw new Error2(
        McpCatalogErrors.codes.MCP_CATALOG_IO_FAILED,
        `Failed to write MCP catalog: ${describeError(error)}`,
        { cause: error },
      );
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { code: string }).code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.App,
  IMcpCatalogServiceToken,
  McpCatalogService,
  ScopeActivation.OnDemand,
  'mcpCatalog',
);
