/**
 * SDK-local config helpers — standalone TOML read/write for the auth facade
 * and bootstrap paths that must work before a v2 runtime is available.
 *
 * These are NOT the canonical config access path (v2 `IConfigService` and
 * `KimiV2Runtime` are).  They exist solely so `KimiAuthFacade` can read and
 * write `config.toml` without importing the legacy `@moonshot-ai/agent-core`
 * package.  The facade's config adapter is the only consumer of the write
 * path; `loadRuntimeConfigSafe` is used for pre-bootstrap config inspection.
 *
 * Design notes:
 *  - Minimal: only the TOML parse/stringify + env-model overlay that the auth
 *    and path-resolution paths need.  Full config validation uses smol-toml
 *    parsing with lenient fallback, matching the legacy `loadRuntimeConfigSafe`
 *    contract.
 *  - Internal types (`KimiConfig`, `ModelAlias`, `ProviderConfig`, etc.) are
 *    defined here for structural compatibility.  They are NOT the v2 canonical
 *    types — they are local data shapes that happen to match the TOML schema
 *    the auth facade writes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { ErrorCodes, KimiError } from '#/sdk-errors';

// ---------------------------------------------------------------------------
// Local type aliases (structural subset of the legacy KimiConfig schema)
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  oauth?: Record<string, unknown>;
  [key: string]: unknown;
}

export type OAuthRef = Record<string, unknown>;

export interface ModelAlias {
  provider: string;
  model: string;
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  baseUrl?: string;
  protocol?: string;
  overrides?: Record<string, unknown>;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
  [key: string]: unknown;
}

export interface KimiConfig {
  defaultModel?: string;
  providers?: Record<string, ProviderConfig>;
  models?: Record<string, ModelAlias>;
  telemetry?: boolean;
  thinking?: { enabled?: boolean; effort?: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaultConfig(): KimiConfig {
  return { providers: {}, models: {} };
}

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

// ---------------------------------------------------------------------------
// TOML helpers
// ---------------------------------------------------------------------------

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

function transformTomlKeys(data: Record<string, unknown>, transform: (key: string) => string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const newKey = transform(k);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[newKey] = transformTomlKeys(v as Record<string, unknown>, transform);
    } else {
      result[newKey] = v;
    }
  }
  return result;
}

function cloneRecord<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneRecord) as unknown as T;
  const cloned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    cloned[k] = cloneRecord(v);
  }
  return cloned as T;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export async function ensureConfigFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function readConfigFile(filePath: string): KimiConfig {
  if (!existsSync(filePath)) {
    return getDefaultConfig();
  }
  const text = readFileSync(filePath, 'utf-8');
  return parseConfigString(text);
}

export function parseConfigString(text: string, filePath = 'config.toml'): KimiConfig {
  if (text.trim().length === 0) return getDefaultConfig();
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = cloneRecord(data);
  // Convert TOML snake_case keys to camelCase
  const transformed = transformTomlKeys(data, snakeToCamel);
  transformed['raw'] = raw;
  return transformed as unknown as KimiConfig;
}

/** Strict read for write paths. */
export function readConfigFileForUpdate(filePath: string): KimiConfig {
  try {
    return readConfigFile(filePath);
  } catch (error) {
    if (error instanceof KimiError && error.code === ErrorCodes.CONFIG_INVALID) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Cannot change settings while ${filePath} is invalid — fix it first (run \`kimi doctor\` for details).`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function writeConfigFile(filePath: string, config: KimiConfig): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  // Remove the raw key before serializing
  const { raw: _raw, ...clean } = config as Record<string, unknown>;
  // Convert camelCase keys back to snake_case for TOML
  const tomlData = transformTomlKeys(clean, camelToSnake);
  const text = stringifyToml(tomlData);
  writeFileSync(filePath, text, 'utf-8');
}

export function writeConfigFileSync(filePath: string, config: KimiConfig): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const { raw: _raw, ...clean } = config as Record<string, unknown>;
  const tomlData = transformTomlKeys(clean, camelToSnake);
  const text = stringifyToml(tomlData);
  writeFileSync(filePath, text, 'utf-8');
}

// ---------------------------------------------------------------------------
// loadRuntimeConfigSafe — lenient variant for pre-bootstrap config reads
// ---------------------------------------------------------------------------

export interface RuntimeConfigLoadResult {
  readonly config: KimiConfig;
  readonly fileWarnings: readonly string[];
  readonly envWarnings: readonly string[];
  readonly fileError?: KimiError;
}

export function loadRuntimeConfigSafe(
  filePath: string,
  _env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfigLoadResult {
  const fileWarnings: string[] = [];
  let fileError: KimiError | undefined;
  let config = getDefaultConfig();

  let text: string | undefined;
  try {
    text = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined;
  } catch (error) {
    fileError = new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    fileWarnings.push(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}.`);
  }

  if (text !== undefined && text.trim().length > 0) {
    let data: Record<string, unknown> | undefined;
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      fileError = new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      fileWarnings.push(`Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (data !== undefined) {
      const raw = cloneRecord(data);
      const transformed = transformTomlKeys(data, snakeToCamel);
      transformed['raw'] = raw;

      // Lenient parse — drop problematic entries per section
      const { config: parsed, warnings } = salvageConfigData(transformed);
      if (parsed !== undefined) {
        config = parsed;
      }
      if (parsed === undefined) {
        fileError = new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Invalid config ${filePath}: ${warnings.join('; ')}`,
        );
      }
      fileWarnings.push(...warnings);
    }
  }

  return { config, fileWarnings, envWarnings: [], fileError };
}

function salvageConfigData(data: Record<string, unknown>): {
  config: KimiConfig | undefined;
  warnings: readonly string[];
} {
  const warnings: string[] = [];
  const result: Record<string, unknown> = {};
  const raw = data['raw'] as Record<string, unknown> | undefined;

  // providers — drop individual entries that fail
  if (data['providers'] !== undefined) {
    if (typeof data['providers'] === 'object' && !Array.isArray(data['providers'])) {
      const providers: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data['providers'] as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object') {
          providers[key] = value;
        } else {
          warnings.push(`Invalid provider entry "${key}" — skipped.`);
        }
      }
      result['providers'] = providers;
    } else {
      warnings.push('Invalid [providers] section — skipped.');
    }
  }

  // models — drop individual entries that fail
  if (data['models'] !== undefined) {
    if (typeof data['models'] === 'object' && !Array.isArray(data['models'])) {
      const models: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data['models'] as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object') {
          models[key] = value;
        } else {
          warnings.push(`Invalid model alias "${key}" — skipped.`);
        }
      }
      result['models'] = models;
    } else {
      warnings.push('Invalid [models] section — skipped.');
    }
  }

  // Everything else — primitive-valued top-level keys
  for (const key of Object.keys(data)) {
    if (key === 'providers' || key === 'models' || key === 'raw') continue;
    result[key] = data[key];
  }

  result['raw'] = raw;
  return { config: result as unknown as KimiConfig, warnings };
}
