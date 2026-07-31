import type { ProviderRequestAuth } from '#/provider';
import type { GoogleGenAI as GenAIClient } from '@google/genai';

export interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  /**
   * Override the endpoint the SDK talks to (forwarded as
   * `httpOptions.baseUrl`). When unset, the SDK falls back to its default
   * (`generativelanguage.googleapis.com` for Gemini, the regional
   * `*-aiplatform.googleapis.com` for Vertex). Set this to route through a
   * Gemini-compatible proxy/gateway.
   */
  baseUrl?: string | undefined;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string>;
  clientFactory?: (auth: ProviderRequestAuth) => GenAIClient;
}

export interface GoogleGenAIGenerationKwargs {
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  topK?: number | undefined;
  topP?: number | undefined;
  thinkingConfig?: ThinkingConfig | undefined;
  [key: string]: unknown;
}

export interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
}
