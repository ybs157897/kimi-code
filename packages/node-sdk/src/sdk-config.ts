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
import { z } from 'zod';

import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';

import { ErrorCodes, KimiError } from '#/sdk-errors';

// The provider/oauth shapes are owned by the v2 engine (`kosong/provider`);
// import them from there so the SDK never redefines a second, drift-prone copy.
export type { ProviderConfig, OAuthRef } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';

// ---------------------------------------------------------------------------
// Config type aliases — the single source for the SDK's config shapes.
//
// `KimiConfig` is the top-level `config.toml` structure: an open set of
// sections (`providers`, `models`, `services`, `web`, `experts`, …), so it
// keeps an index signature for the sections the SDK does not model. The
// per-section types (`ProviderConfig`, `ModelAlias`) are closed and strongly
// typed — no index signature — so declared-field access (`.providers`,
// `.displayName`, …) is legal under `noPropertyAccessFromIndexSignature`.
// Field names follow the v2 engine's kosong config schemas.
// ---------------------------------------------------------------------------

export interface ModelAlias {
  provider: string;
  model: string;
  providerId?: string;
  name?: string;
  aliases?: string[];
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  betaApi?: boolean;
  overrides?: Record<string, unknown>;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
}

export interface KimiConfig {
  defaultModel?: string;
  providers?: Record<string, ProviderConfig>;
  models?: Record<string, ModelAlias>;
  telemetry?: boolean;
  thinking?: { enabled?: boolean; effort?: string };
  [key: string]: unknown;
}

const StringRecordSchema = z.record(z.string(), z.string());
const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});
const ProviderConfigSchema = z.object({
  modelSource: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  baseUrl: z.string().optional(),
  customHeaders: StringRecordSchema.optional(),
  defaultModel: z.string().optional(),
  type: z
    .enum([
      'anthropic',
      'openai',
      'kimi',
      'google-genai',
      'openai_responses',
      'vertexai',
    ])
    .optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});
const ModelOverrideSchema = z.object({
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});
const ModelAliasSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    providerId: z.string().optional(),
    name: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    maxContextSize: z.number().int().min(1).optional(),
    maxInputSize: z.number().int().min(1).optional(),
    maxOutputSize: z.number().int().min(1).optional(),
    capabilities: z.array(z.string()).optional(),
    displayName: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    oauth: OAuthRefSchema.optional(),
    protocol: z.string().optional(),
    reasoningKey: z.string().optional(),
    adaptiveThinking: z.boolean().optional(),
    betaApi: z.boolean().optional(),
    overrides: ModelOverrideSchema.optional(),
    supportEfforts: z.array(z.string()).optional(),
    defaultEffort: z.string().optional(),
    offEffort: z.string().optional(),
  })
  .superRefine((model, context) => {
    if (
      (model.provider !== undefined || model.model !== undefined) &&
      model.maxContextSize === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['maxContextSize'],
        message: 'Expected a positive integer',
      });
    }
  });
const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});
const ServicesConfigSchema = z.object({
  moonshotSearch: MoonshotServiceConfigSchema.optional(),
  moonshotFetch: MoonshotServiceConfigSchema.optional(),
});
const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});
const BackgroundConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  bashTaskTimeoutS: z.number().int().min(0).optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: z.enum(['exit', 'drain', 'steer']).optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});
const KimiConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  telemetry: z.boolean().optional(),
  thinking: z
    .object({
      enabled: z.boolean().optional(),
      effort: z.string().optional(),
      keep: z.string().optional(),
    })
    .optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  defaultPermissionMode: z.enum(['yolo', 'manual', 'auto']).optional(),
  defaultPlanMode: z.boolean().optional(),
  permission: z.record(z.string(), z.unknown()).optional(),
  hooks: z.array(z.record(z.string(), z.unknown())).optional(),
  services: ServicesConfigSchema.optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  extraSkillDirs: z.array(z.string()).optional(),
  loopControl: LoopControlSchema.optional(),
  background: BackgroundConfigSchema.optional(),
  subagent: z.record(z.string(), z.unknown()).optional(),
  mcp: z.record(z.string(), z.unknown()).optional(),
  image: z
    .object({
      maxEdgePx: z.number().int().min(1).optional(),
      readByteBudget: z.number().int().min(1).optional(),
    })
    .optional(),
  modelCatalog: z.record(z.string(), z.unknown()).optional(),
  experimental: z.record(z.string(), z.boolean()).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaultConfig(): KimiConfig {
  return { providers: {} };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    result[snakeToCamel(k)] = v;
  }
  return result;
}

function transformRecord(
  value: Record<string, unknown>,
  transformEntry: (entry: Record<string, unknown>) => Record<string, unknown>,
  transformName: (name: string) => string = (name) => name,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      transformName(name),
      isPlainObject(entry) ? transformEntry(entry) : entry,
    ]),
  );
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      result[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      result[targetKey] = cloneRecord(value);
    } else {
      result[targetKey] = value;
    }
  }
  return result;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  const result = transformPlainObject(data);
  if (isPlainObject(result['overrides'])) {
    result['overrides'] = transformPlainObject(result['overrides']);
  }
  return result;
}

function transformServiceData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      result[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      result[targetKey] = cloneRecord(value);
    } else {
      result[targetKey] = value;
    }
  }
  return result;
}

function transformLoopControlData(data: Record<string, unknown>): Record<string, unknown> {
  const result = transformPlainObject(data);
  if (result['maxStepsPerTurn'] === undefined && result['maxStepsPerRun'] !== undefined) {
    result['maxStepsPerTurn'] = result['maxStepsPerRun'];
  }
  delete result['maxStepsPerRun'];
  return result;
}

function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'providers' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'services' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformServiceData, snakeToCamel);
    } else if (targetKey === 'loopControl' && isPlainObject(value)) {
      result[targetKey] = transformLoopControlData(value);
    } else if (
      [
        'thinking',
        'background',
        'image',
        'subagent',
        'mcp',
        'modelCatalog',
      ].includes(targetKey) &&
      isPlainObject(value)
    ) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'experimental' && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if (!isPlainObject(value) || targetKey === 'permission') {
      result[targetKey] = value;
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
  const transformed = transformTomlData(data);
  transformed['raw'] = raw;
  try {
    return KimiConfigSchema.parse(transformed) as KimiConfig;
  } catch (error) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid configuration in ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
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

export function mergeConfigPatch(
  config: KimiConfig,
  patch: Record<string, unknown>,
): KimiConfig {
  try {
    const base = KimiConfigSchema.parse(config) as Record<string, unknown>;
    const merged = deepMerge(base, stripUndefinedDeep(patch) as Record<string, unknown>);
    return KimiConfigSchema.parse(merged) as KimiConfig;
  } catch (error) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid configuration patch: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] =
      isPlainObject(targetValue) && isPlainObject(sourceValue)
        ? deepMerge(targetValue, sourceValue)
        : sourceValue;
  }
  return result;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Exclude<unknown, undefined>] => entry[1] !== undefined)
      .map(([key, entryValue]) => [key, stripUndefinedDeep(entryValue)]),
  );
}

export async function writeConfigFile(filePath: string, config: KimiConfig): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${stringifyToml(configToTomlData(config))}\n`, 'utf-8');
}

export function writeConfigFileSync(filePath: string, config: KimiConfig): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${stringifyToml(configToTomlData(config))}\n`, 'utf-8');
}

function configToTomlData(config: KimiConfig): Record<string, unknown> {
  const validated = KimiConfigSchema.parse(config) as KimiConfig;
  const output = cloneObject(validated['raw']);

  delete output['default_yolo'];
  delete output['defaultYolo'];
  delete output['defaultPermissionMode'];
  delete output['default_thinking'];
  delete output['defaultThinking'];

  for (const key of [
    'defaultProvider',
    'defaultModel',
    'planMode',
    'yolo',
    'defaultPermissionMode',
    'defaultPlanMode',
    'mergeAllAvailableSkills',
    'extraSkillDirs',
    'telemetry',
  ] as const) {
    setDefined(output, camelToSnake(key), validated[key]);
  }

  setRecordSection(output, 'providers', validated.providers, providerToToml);
  setRecordSection(output, 'models', validated.models, modelToToml);
  setObjectSection(output, 'thinking', validated.thinking, plainObjectToToml);
  setObjectSection(output, 'services', validated['services'], servicesToToml);
  setObjectSection(output, 'loop_control', validated['loopControl'], plainObjectToToml);
  setObjectSection(output, 'background', validated['background'], plainObjectToToml);
  setObjectSection(output, 'subagent', validated['subagent'], plainObjectToToml);
  setObjectSection(output, 'mcp', validated['mcp'], plainObjectToToml);
  setObjectSection(output, 'image', validated['image'], plainObjectToToml);
  setObjectSection(output, 'model_catalog', validated['modelCatalog'], plainObjectToToml);
  setObjectSection(output, 'experimental', validated['experimental'], preserveKeysToToml);
  setObjectSection(output, 'permission', validated['permission'], plainObjectToToml);
  setHooks(output, validated['hooks']);

  return output;
}

function setRecordSection(
  output: Record<string, unknown>,
  key: string,
  value: Record<string, unknown> | undefined,
  convert: (entry: Record<string, unknown>, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete output[key];
    return;
  }
  const rawSection = cloneObject(output[key]);
  const converted: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    converted[name] = convert(entry as Record<string, unknown>, rawSection[name]);
  }
  if (Object.keys(converted).length === 0) {
    delete output[key];
  } else {
    output[key] = converted;
  }
}

function setObjectSection(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
  convert: (entry: Record<string, unknown>, raw: unknown) => Record<string, unknown>,
): void {
  if (!isPlainObject(value)) {
    delete output[key];
    return;
  }
  const converted = convert(value, output[key]);
  if (Object.keys(converted).length === 0) {
    delete output[key];
  } else {
    output[key] = converted;
  }
}

function providerToToml(
  provider: Record<string, unknown>,
  rawProvider: unknown,
): Record<string, unknown> {
  const output = cloneObject(rawProvider);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'oauth' && isPlainObject(value)) {
      output['oauth'] = plainObjectToToml(value, undefined);
    } else if ((key === 'env' || key === 'customHeaders') && isPlainObject(value)) {
      output[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(output, camelToSnake(key), value);
    }
  }
  return output;
}

function modelToToml(
  model: Record<string, unknown>,
  rawModel: unknown,
): Record<string, unknown> {
  const output = cloneObject(rawModel);
  for (const [key, value] of Object.entries(model)) {
    if (key === 'overrides' && isPlainObject(value)) {
      output['overrides'] = plainObjectToToml(value, output['overrides']);
    } else {
      setDefined(output, camelToSnake(key), value);
    }
  }
  return output;
}

function servicesToToml(
  services: Record<string, unknown>,
  rawServices: unknown,
): Record<string, unknown> {
  const output = cloneObject(rawServices);
  for (const [name, value] of Object.entries(services)) {
    const snakeName = camelToSnake(name);
    if (!isPlainObject(value)) {
      delete output[snakeName];
      continue;
    }
    const service: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (key === 'oauth' && isPlainObject(field)) {
        service['oauth'] = plainObjectToToml(field, undefined);
      } else if (key === 'customHeaders' && isPlainObject(field)) {
        service['custom_headers'] = cloneRecord(field);
      } else {
        setDefined(service, camelToSnake(key), field);
      }
    }
    output[snakeName] = service;
  }
  return output;
}

function plainObjectToToml(
  value: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  const output = cloneObject(raw);
  for (const [key, field] of Object.entries(value)) {
    setDefined(output, camelToSnake(key), field);
  }
  return output;
}

function preserveKeysToToml(
  value: Record<string, unknown>,
  _raw: unknown,
): Record<string, unknown> {
  return cloneObject(value);
}

function setHooks(output: Record<string, unknown>, hooks: unknown): void {
  if (!Array.isArray(hooks)) {
    delete output['hooks'];
    return;
  }
  output['hooks'] = hooks.map((hook) =>
    isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook,
  );
}

function cloneObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? cloneRecord(value) : {};
}

function setDefined(output: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete output[key];
  } else {
    output[key] = value;
  }
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
      const transformed = transformTomlData(data);
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
  const candidate = cloneRecord(data);
  for (;;) {
    const parsed = KimiConfigSchema.safeParse(candidate);
    if (parsed.success) {
      return { config: parsed.data as KimiConfig, warnings };
    }

    let removed = false;
    for (const issue of parsed.error.issues) {
      const [section, entry] = issue.path;
      if (typeof section !== 'string' || !(section in candidate)) continue;
      const sectionValue = candidate[section];
      if (
        (section === 'providers' || section === 'models') &&
        typeof entry === 'string' &&
        isPlainObject(sectionValue) &&
        entry in sectionValue
      ) {
        delete sectionValue[entry];
        warnings.push(
          `Invalid ${section.slice(0, -1)} entry "${entry}" at ${section}.${entry} — skipped.`,
        );
        removed = true;
        continue;
      }
      delete candidate[section];
      warnings.push(`Invalid [${camelToSnake(section)}] section — skipped.`);
      removed = true;
    }

    if (!removed) return { config: undefined, warnings };
  }
}
