import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages/messages.js';

import type { ChatProviderError } from '#/kosong/contract/errors';
import type { ProviderRequestAuth, ThinkingEffort } from '#/kosong/contract/provider';

export interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams['thinking'] | undefined;
  output_config?: MessageCreateParams['output_config'] | undefined;
  betaFeatures?: string[] | undefined;
  contextManagement?: AnthropicContextManagement;
}

interface AnthropicContextManagement {
  edits: Array<{ type: string; keep?: unknown }>;
}

/**
 * The base-internal hook set: the L1 `withThinking` hook with the context
 * already bound away. It receives a defensive COPY of the seeded kwargs, so a
 * hook can never mutate base state — and a construction-headers synthetic
 * trait can never shadow a real dialect hook (the compositor picks the last
 * declarer).
 */
export interface AnthropicHooks {
  withThinking?(
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: AnthropicGenerationKwargs,
  ): AnthropicGenerationKwargs | undefined;
  convertError?: (error: unknown) => ChatProviderError | undefined;
}

export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  stream?: boolean | undefined;
  adaptiveThinking?: boolean | undefined;
  supportEfforts?: readonly string[] | undefined;
  betaApi?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
  hooks?: AnthropicHooks | undefined;
}
