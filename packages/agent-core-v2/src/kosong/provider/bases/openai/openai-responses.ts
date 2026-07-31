/**
 * `kosong/provider` domain (L2) — OpenAI Responses API wire base.
 *
 * Speaks the Responses wire format: `input` items, `instructions`,
 * `reasoning` blocks with encrypted content, and the native
 * `prompt_cache_key` field (a cache key is encoded directly — no hook
 * needed). This base carries no hook surface today; per-turn intents are
 * encoded inline in the fixed contract order. The developer-role model
 * detection lives here.
 */

import OpenAI from 'openai';

import type { ChatProviderError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';

import { convertOpenAIError, type ToolMessageConversion } from './openai-common';
import { asRawObject } from './openai-responses-decode';
import {
  OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
  convertHistoryMessages,
  convertTool,
  responseFormatToResponsesText,
} from './openai-responses-request';
import { OpenAIResponsesStreamedMessage } from './openai-responses-stream';
import type {
  OpenAIResponsesGenerationKwargs,
  OpenAIResponsesOptions,
} from './openai-responses-types';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from '../request-auth';
import { normalizeToolCallIdsForProvider } from '../tool-call-id';

export type {
  OpenAIResponsesGenerationKwargs,
  OpenAIResponsesOptions,
} from './openai-responses-types';
export {
  getOpenAIResponsesModelCapability,
  usesOpenAIResponsesDeveloperRole,
} from './openai-responses-capability';
export { OpenAIResponsesStreamedMessage } from './openai-responses-stream';

export class OpenAIResponsesChatProvider implements ChatProvider {
  readonly name: string = 'openai-responses';

  private readonly _model: string;
  private readonly _stream: boolean;
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _thinkingEffort: ThinkingEffort | undefined;
  private readonly _offEffort: string | undefined;
  private readonly _generationKwargs: OpenAIResponsesGenerationKwargs;
  private readonly _toolMessageConversion: ToolMessageConversion;
  private readonly _client: OpenAI | undefined;
  private readonly _httpClient: unknown;
  private readonly _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;
  private readonly _convertErrorHook: ((error: unknown) => ChatProviderError | undefined) | undefined;

  constructor(options: OpenAIResponsesOptions) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = true;
    this._thinkingEffort = options.thinkingEffort;
    this._offEffort = options.offEffort;
    this._generationKwargs = {};
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;
    this._convertErrorHook = options.convertError;

    if (options.maxOutputTokens !== undefined) {
      this._generationKwargs.max_output_tokens = options.maxOutputTokens;
    }

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._thinkingEffort ?? null;
  }

  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_output_tokens;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const input: unknown[] = [];

    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
    );
    input.push(
      ...convertHistoryMessages(normalizedHistory, this._model, this._toolMessageConversion),
    );

    let kwargs: Record<string, unknown> = { ...this._generationKwargs };

    // Per-turn intent overlays in the fixed contract order.
    if (options?.cacheKey !== undefined) {
      kwargs = { ...kwargs, prompt_cache_key: options.cacheKey };
    }
    if (options?.sampling?.temperature !== undefined) {
      kwargs = { ...kwargs, temperature: options.sampling.temperature };
    }
    if (options?.sampling?.topP !== undefined) {
      kwargs = { ...kwargs, top_p: options.sampling.topP };
    }

    const thinking =
      options?.thinking ??
      (this._thinkingEffort !== undefined ? { effort: this._thinkingEffort } : undefined);
    if (thinking !== undefined) {
      const effort =
        thinking.effort === 'off'
          ? this._offEffort
          : thinking.effort === 'on'
            ? undefined
            : thinking.effort;
      kwargs = { ...kwargs, reasoning_effort: effort };
    }

    if (options?.maxCompletionTokens !== undefined) {
      let cap = options.maxCompletionTokens;
      if (
        options.usedContextTokens !== undefined &&
        options.maxContextTokens !== undefined &&
        options.maxContextTokens > 0
      ) {
        cap = Math.min(cap, options.maxContextTokens - options.usedContextTokens);
      }
      kwargs = { ...kwargs, max_output_tokens: Math.max(1, cap) };
    }

    const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete kwargs['reasoning_effort'];

    if (reasoningEffort !== undefined) {
      kwargs['reasoning'] = {
        effort: reasoningEffort,
        summary: 'auto',
      };
      kwargs['include'] = ['reasoning.encrypted_content'];
    }

    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    try {
      const client = this._createClient(options?.auth);
      const createParams: Record<string, unknown> = {
        model: this._model,
        input,
        tools: tools.map((t) => convertTool(t)),
        store: false,
        stream: this._stream,
        ...kwargs,
      };
      if (systemPrompt) {
        createParams['instructions'] = systemPrompt;
      }
      if (options?.responseFormat !== undefined) {
        createParams['text'] = {
          ...asRawObject(createParams['text']),
          ...responseFormatToResponsesText(options.responseFormat),
        };
      }

      if (
        !('responses' in client) ||
        typeof (client as { responses?: { create?: unknown } }).responses?.create !== 'function'
      ) {
        throw new Error(
          'OpenAI SDK version does not support Responses API. Upgrade to >=4.x with responses support.',
        );
      }

      options?.onRequestSent?.();
      const response = await (
        client.responses as {
          create(params: unknown, opts?: unknown): Promise<unknown>;
        }
      ).create(createParams, options?.signal ? { signal: options.signal } : undefined);
      return new OpenAIResponsesStreamedMessage(response, this._stream, this._convertErrorHook);
    } catch (error: unknown) {
      throw convertOpenAIError(error, this._convertErrorHook);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) =>
        this._buildClient(requireProviderApiKey('OpenAIResponsesChatProvider', a, this._apiKey), a),
    );
  }

  private _buildClient(apiKey: string, auth?: ProviderRequestAuth): OpenAI {
    const clientOpts: Record<string, unknown> = {
      apiKey,
      baseURL: this._baseUrl,
    };
    const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, auth?.headers);
    if (defaultHeaders !== undefined) {
      clientOpts['defaultHeaders'] = defaultHeaders;
    }
    if (this._httpClient !== undefined) {
      clientOpts['httpClient'] = this._httpClient;
    }
    return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }
}
