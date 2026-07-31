import type { ChatProviderError } from '#/errors';
import type { ProviderRequestAuth } from '#/provider';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages/messages.js';

export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  /** Use streaming API. Defaults to true. Set to false for non-streaming (test/fallback). */
  stream?: boolean | undefined;
  /**
   * Explicitly declare whether the model supports adaptive thinking
   * (`thinking: { type: 'adaptive' }`), overriding the model-name version
   * inference. Useful for custom-named endpoints whose model name does not
   * encode a parseable Claude version. Leave undefined to infer from the name.
   */
  adaptiveThinking?: boolean | undefined;
  /**
   * Concrete thinking efforts declared by the model catalog. When omitted,
   * the provider infers a Claude profile from the model name and falls back to
   * the latest Opus profile for unrecognized Anthropic-compatible models.
   */
  supportEfforts?: readonly string[] | undefined;
  kimiThinking?: boolean | undefined;
  /**
   * Use the Anthropic **beta** Messages API (`client.beta.messages.create`,
   * `POST /v1/messages?beta=true`) instead of the standard Messages API.
   *
   * Beta features (`betaFeatures`) are then sent via the request `betas`
   * field rather than the `anthropic-beta` header. Defaults to false, which
   * keeps the standard endpoint + header behavior.
   */
  betaApi?: boolean | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
  convertError?: (error: unknown) => ChatProviderError | undefined;
}

export interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams['thinking'] | undefined;
  output_config?: MessageCreateParams['output_config'] | undefined;
  betaFeatures?: string[] | undefined;
  contextManagement?: AnthropicContextManagement | undefined;
}

/**
 * Anthropic beta context-management payload (`context-management-2025-06-27`).
 * Only the `clear_thinking_20251015` edit is emitted today, with `keep`
 * forwarded as a string (`"all"`); the `{ type, value }` turn-count form is
 * not used because the shared `[thinking] keep` config is a string.
 */
export interface AnthropicContextManagement {
  edits: Array<{ type: string; keep?: unknown }>;
}
