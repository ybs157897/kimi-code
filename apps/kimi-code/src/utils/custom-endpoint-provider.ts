import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

export const DEFAULT_CUSTOM_ENDPOINT_CONTEXT_SIZE = 131_072;

export const CUSTOM_ENDPOINT_PROTOCOLS = ['chat', 'responses', 'anthropic'] as const;

export type CustomEndpointProtocol = (typeof CUSTOM_ENDPOINT_PROTOCOLS)[number];

export interface CustomEndpointInput {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly protocol: CustomEndpointProtocol;
  readonly modelId: string;
  readonly modelName: string;
  readonly maxContextSize: number;
}

export interface AppliedCustomEndpoint {
  readonly providerId: string;
  readonly alias: string;
  readonly modelName: string;
}

interface NormalizedCustomEndpointInput extends CustomEndpointInput {
  readonly providerType: 'openai' | 'openai_responses' | 'anthropic';
}

export function applyCustomEndpointProvider(
  config: KimiConfig,
  input: CustomEndpointInput,
): AppliedCustomEndpoint {
  const normalized = normalizeCustomEndpointInput(input);
  const alias = `${normalized.providerId}/${normalized.modelId}`;

  config.providers ??= {};
  config.providers[normalized.providerId] = {
    type: normalized.providerType,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey,
  };
  config.models ??= {};
  config.models[alias] = {
    provider: normalized.providerId,
    model: normalized.modelId,
    displayName: normalized.modelName,
    maxContextSize: normalized.maxContextSize,
    capabilities: ['tool_use'],
  };
  config.defaultModel = alias;

  return {
    providerId: normalized.providerId,
    alias,
    modelName: normalized.modelName,
  };
}

export function normalizeCustomEndpointInput(
  input: CustomEndpointInput,
): NormalizedCustomEndpointInput {
  if (!CUSTOM_ENDPOINT_PROTOCOLS.includes(input.protocol)) {
    throw new Error('Protocol must be one of: chat, responses, anthropic.');
  }

  const providerId = input.providerId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
    throw new Error('Provider ID may only contain letters, numbers, dots, underscores, and hyphens.');
  }

  const rawBaseUrl = input.baseUrl.trim();
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error('Base URL must be a valid absolute URL.');
  }
  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new Error('Base URL must use http or https.');
  }
  const baseUrl =
    input.protocol === 'anthropic'
      ? rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')
      : rawBaseUrl.replace(/\/$/, '');

  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error('API key cannot be empty.');
  }

  const modelId = input.modelId.trim();
  if (modelId.length === 0) {
    throw new Error('Model ID cannot be empty.');
  }
  const modelName = input.modelName.trim();
  if (modelName.length === 0) {
    throw new Error('Model name cannot be empty.');
  }
  if (!Number.isSafeInteger(input.maxContextSize) || input.maxContextSize <= 0) {
    throw new Error('Context size must be a positive integer.');
  }

  const providerType =
    input.protocol === 'chat'
      ? 'openai'
      : input.protocol === 'responses'
        ? 'openai_responses'
        : 'anthropic';

  return {
    providerId,
    baseUrl,
    apiKey,
    protocol: input.protocol,
    providerType,
    modelId,
    modelName,
    maxContextSize: input.maxContextSize,
  };
}
