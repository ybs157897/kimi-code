import type { ProviderRequestAuth } from '#/provider';
import type OpenAI from 'openai';

import type { ToolMessageConversion } from './openai-common';

export interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  maxOutputTokens?: number | undefined;
  /**
   * The effort value that encodes "thinking off" on this wire (e.g. `'none'`
   * for xai grok). When set, `withThinking('off')` sends it as
   * `reasoning_effort` instead of omitting the field — required by models
   * whose default is to reason.
   */
  offEffort?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  /**
   * Construction-time free-form request kwargs (e.g. `prompt_cache_key` for
   * session affinity), merged into every request at generate time. Explicit
   * first-class options (`maxOutputTokens`) win on conflict; the
   * `withGenerationKwargs` morph layers on top of both.
   */
  generationKwargs?: OpenAIResponsesGenerationKwargs | undefined;
}

export interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
}
