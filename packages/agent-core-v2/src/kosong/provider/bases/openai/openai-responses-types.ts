import type OpenAI from 'openai';

import type { ChatProviderError } from '#/kosong/contract/errors';
import type { ProviderRequestAuth, ThinkingEffort } from '#/kosong/contract/provider';

import type { ToolMessageConversion } from './openai-common';

export interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  maxOutputTokens?: number | undefined;
  offEffort?: string | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  convertError?: (error: unknown) => ChatProviderError | undefined;
}

export interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
}
