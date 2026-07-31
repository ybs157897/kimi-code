import type { Message } from '#/message';
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import OpenAI from 'openai';

import { convertOpenAIError, type ToolMessageConversion } from './openai-common';
import { asRawObject } from './openai-responses-decode';
import {
  convertHistoryMessages,
  convertTool,
  OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
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
} from './request-auth';
import { normalizeToolCallIdsForProvider } from './tool-call-id';

export type {
  OpenAIResponsesGenerationKwargs,
  OpenAIResponsesOptions,
} from './openai-responses-types';
export { OpenAIResponsesStreamedMessage } from './openai-responses-stream';

export class OpenAIResponsesChatProvider implements ChatProvider {
  readonly name: string = 'openai-responses';

  /** See {@link ChatProvider.maxCompletionTokens}. */
  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_output_tokens;
  }

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _generationKwargs: OpenAIResponsesGenerationKwargs;
  private _offEffort: string | undefined;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI | undefined;
  private _httpClient: unknown;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;

  constructor(options: OpenAIResponsesOptions) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = true; // Responses API always supports streaming
    this._generationKwargs = { ...options.generationKwargs };
    this._offEffort = options.offEffort;
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    if (options.maxOutputTokens !== undefined) {
      this._generationKwargs.max_output_tokens = options.maxOutputTokens;
    }

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const effort = this._generationKwargs.reasoning_effort;
    if (effort === undefined) return null;
    return effort === 'none' ? 'off' : effort;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
    };
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

    const kwargs: Record<string, unknown> = { ...this._generationKwargs };
    const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
    delete kwargs['reasoning_effort'];

    if (reasoningEffort !== undefined) {
      kwargs['reasoning'] = {
        effort: reasoningEffort,
        summary: 'auto',
      };
      kwargs['include'] = ['reasoning.encrypted_content'];
    }

    // Remove undefined values
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
      return new OpenAIResponsesStreamedMessage(response, this._stream);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): OpenAIResponsesChatProvider {
    // 'on' sends no effort field; 'off' sends the model's declared off value
    // (e.g. 'none') when one is configured, and omits the field otherwise.
    const reasoningEffort =
      effort === 'off' ? this._offEffort : effort === 'on' ? undefined : effort;
    const clone = this._clone();
    clone._generationKwargs = {
      ...clone._generationKwargs,
      reasoning_effort: reasoningEffort,
    };
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAIResponsesGenerationKwargs): OpenAIResponsesChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): OpenAIResponsesChatProvider {
    return this.withGenerationKwargs({ max_output_tokens: maxCompletionTokens });
  }

  private _clone(): OpenAIResponsesChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAIResponsesChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
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
