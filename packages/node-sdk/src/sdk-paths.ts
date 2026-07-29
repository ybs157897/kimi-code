/**
 * SDK-local path helpers — thin wrappers that resolve Kimi Code directory /
 * config / log paths without depending on the legacy agent-core package.
 *
 * Originally re-exported from `@moonshot-ai/agent-core`, these are trivial
 * enough to maintain locally.  They are the fallback used before a v2 runtime
 * is bootstrapped; after bootstrap the v2 `IHostFileSystem` / `IConfigService`
 * own canonical resolution.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveKimiHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}

export function resolveGlobalLogPath(homeDir: string): string {
  return join(homeDir, 'logs', 'kimi-code.log');
}
