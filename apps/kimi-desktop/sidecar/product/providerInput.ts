/**
 * Product facade provider/model input parsing — maps the web client's wire
 * provider body (AppProviderInput) onto the kosong config-layer shapes
 * (ProviderConfig + ModelsSection records), mirroring kap-server's provider
 * route validation.
 */

import { RPCError } from '@moonshot-ai/klient';
import { PROVIDER_ID_PATTERN } from '@moonshot-ai/agent-core-v2';
import type { ModelRecord, ModelsSection } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';

import { REQUEST_INVALID } from './constants.js';
import { isRecord, optionalString, requireString } from './helpers.js';

export interface ProviderModelInput {
  readonly model: string;
  readonly displayName?: string;
  readonly maxContextSize: number;
}

export interface ProviderInput {
  readonly id: string;
  readonly type: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly models: readonly ProviderModelInput[];
}

const PROVIDER_TYPES = new Set([
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
]);

export function parseProviderInput(
  raw: unknown,
  requireId: boolean,
  fallbackId?: string,
): ProviderInput {
  if (!isRecord(raw)) throw new RPCError(REQUEST_INVALID, 'provider input must be an object');
  const idValue = raw['new_id'] ?? raw['id'] ?? fallbackId;
  const id = requireString(idValue, requireId ? 'provider id' : 'provider id or new_id');
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new RPCError(REQUEST_INVALID, `invalid provider id: ${id}`);
  }
  const type = requireString(raw['type'], 'provider type');
  if (!PROVIDER_TYPES.has(type)) {
    throw new RPCError(REQUEST_INVALID, `unsupported provider type: ${type}`);
  }
  if (!Array.isArray(raw['models']) || raw['models'].length === 0) {
    throw new RPCError(REQUEST_INVALID, 'provider must define at least one model');
  }
  const modelNames = new Set<string>();
  const models = raw['models'].map((value) => {
    if (!isRecord(value)) throw new RPCError(REQUEST_INVALID, 'provider model must be an object');
    const model = requireString(value['model'], 'model name');
    if (modelNames.has(model)) {
      throw new RPCError(REQUEST_INVALID, `duplicate model: ${model}`);
    }
    modelNames.add(model);
    const size = value['max_context_size'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new RPCError(REQUEST_INVALID, `model ${model} has an invalid context size`);
    }
    return {
      model,
      displayName: optionalString(value['display_name']),
      maxContextSize: size,
    };
  });
  const apiKey =
    Object.prototype.hasOwnProperty.call(raw, 'api_key')
      ? optionalString(raw['api_key']) ?? ''
      : undefined;
  const baseUrl = optionalString(raw['base_url']);
  if (baseUrl?.includes('${') === true) {
    throw new RPCError(REQUEST_INVALID, 'base_url must not contain an environment placeholder');
  }
  const defaultModel = optionalString(raw['default_model']);
  if (defaultModel !== undefined && !modelNames.has(defaultModel)) {
    throw new RPCError(REQUEST_INVALID, 'default_model must be one of models[].model');
  }
  return {
    id,
    type,
    apiKey,
    baseUrl,
    defaultModel,
    models,
  };
}

export function providerConfigFromInput(input: ProviderInput, id: string): ProviderConfig {
  return {
    type: input.type,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    defaultModel:
      input.defaultModel === undefined ? undefined : `${id}/${input.defaultModel}`,
  };
}

export function modelRecordsFromInput(
  input: ProviderInput,
  id: string,
  previous: ModelsSection = {},
  previousProviderId = id,
): ModelsSection {
  const records: ModelsSection = {};
  for (const item of input.models) {
    const previousRecord = Object.values(previous).find(
      (record) => record.provider === previousProviderId && record.model === item.model,
    );
    const alias = `${id}/${item.model}`;
    const record: ModelRecord = {
      ...previousRecord,
      provider: id,
      model: item.model,
      displayName: item.displayName,
      maxContextSize: item.maxContextSize,
    };
    records[alias] = record;
  }
  return records;
}
