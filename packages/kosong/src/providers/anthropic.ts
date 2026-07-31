import { ChatProviderError } from '#/errors';
import type { Message } from '#/message';
import { isToolDeclarationOnlyMessage } from '#/message';
import type {
  ChatProvider,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageCreateParams,
  MessageCreateParamsStreaming,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import { convertAnthropicError } from './anthropic-errors';
import { resolveDefaultMaxTokens } from './anthropic-max-tokens';
import {
  ANTHROPIC_TOOL_CALL_ID_POLICY,
  CACHE_CONTROL,
  applyResponseFormat,
  convertMessage,
  convertTool,
  injectCacheControlOnLastBlock,
  isToolResultOnly,
  shouldKeepConvertedMessage,
  type AnthropicToolParam,
} from './anthropic-request';
import { AnthropicStreamedMessage } from './anthropic-stream';
import {
  CLEAR_THINKING_EDIT,
  CONTEXT_MANAGEMENT_BETA,
  INTERLEAVED_THINKING_BETA,
  budgetTokensForEffort,
  resolveThinkingProfile,
} from './anthropic-thinking';
import type { AnthropicGenerationKwargs, AnthropicOptions } from './anthropic-types';
import { mergeConsecutiveUserMessages } from './merge-user-messages';
import { mergeRequestHeaders, resolveAuthBackedClient } from './request-auth';
import { normalizeToolCallIdsForProvider } from './tool-call-id';

export type { AnthropicOptions } from './anthropic-types';
export { convertAnthropicError } from './anthropic-errors';
export { resolveDefaultMaxTokens } from './anthropic-max-tokens';

export class AnthropicChatProvider implements ChatProvider {
  readonly name: string = 'anthropic';

  /**
   * See {@link ChatProvider.maxCompletionTokens}. `max_tokens` is required by
   * the Messages API and is initialized in the constructor, so this reflects
   * the wire value even when no completion budget was applied.
   */
  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_tokens;
  }

  private _model: string;
  private _stream: boolean;
  private _client: Anthropic | undefined;
  private _generationKwargs: AnthropicGenerationKwargs;
  private _metadata: Record<string, string> | undefined;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string | null> | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => Anthropic) | undefined;
  private _adaptiveThinking: boolean | undefined;
  private readonly _supportEfforts: readonly string[] | undefined;
  private readonly _kimiThinking: boolean;
  private readonly _convertErrorHook: ((error: unknown) => ChatProviderError | undefined) | undefined;
  private _betaApi: boolean;
  private _explicitMaxTokens: boolean;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._adaptiveThinking = options.adaptiveThinking;
    this._supportEfforts = options.supportEfforts;
    this._kimiThinking = options.kimiThinking ?? false;
    this._convertErrorHook = options.convertError;
    this._betaApi = options.betaApi ?? false;
    this._apiKey =
      options.apiKey === undefined || options.apiKey.length === 0 ? undefined : options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
    this._explicitMaxTokens = options.defaultMaxTokens !== undefined;
    this._generationKwargs = {
      max_tokens: options.defaultMaxTokens ?? resolveDefaultMaxTokens(options.model),
      betaFeatures: options.betaFeatures ?? [INTERLEAVED_THINKING_BETA],
    };
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinking = this._generationKwargs.thinking;
    if (thinking === undefined || thinking === null) return null;
    if (thinking.type === 'disabled') return 'off';

    const effort = this._generationKwargs.output_config?.effort;
    if (typeof effort === 'string' && effort.length > 0) return effort;
    if (thinking.type === 'adaptive') return 'on';

    const budget = (thinking as { budget_tokens?: number }).budget_tokens;
    if (budget === undefined) return 'on';
    if (budget <= 1024) return 'low';
    if (budget <= 4096) return 'medium';
    return 'high';
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // Build system param
    const system: TextBlockParam[] | undefined = systemPrompt
      ? [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: CACHE_CONTROL,
          } as TextBlockParam,
        ]
      : undefined;

    // Convert messages, then merge consecutive user messages into one. Strict
    // Anthropic-compatible backends reject consecutive user messages with HTTP
    // 400 ("roles must alternate"), and api.anthropic.com concatenates them
    // anyway — so merging is safe for native Anthropic and required for strict
    // backends. Consecutive plain-text user messages arise naturally after
    // compaction (kept user prompts + user-role summary + injected reminders)
    // and from back-to-back system messages converted to user role above; a
    // tool-result user turn followed by a text turn arises from steering after
    // a tool result. The shared helper applies the asymmetric merge rule (see
    // mergeConsecutiveUserMessages) so this provider and Gemini/Vertex stay in
    // step.
    const messages = mergeConsecutiveUserMessages(
      normalizeToolCallIdsForProvider(
        // Message-level tool declarations are a Kimi wire feature; here the
        // whole message is skipped (an empty leftover would serialize as a
        // garbage `<system></system>` user turn). See isToolDeclarationOnlyMessage.
        history.filter((msg) => !isToolDeclarationOnlyMessage(msg)),
        ANTHROPIC_TOOL_CALL_ID_POLICY,
      )
        .map((msg) => convertMessage(msg, this._model))
        .filter(shouldKeepConvertedMessage),
      {
        isUser: (message) => message.role === 'user',
        isToolResultOnly,
        merge: (last, next) => ({
          ...last,
          content: [
            ...(last.content as ContentBlockParam[]),
            ...(next.content as ContentBlockParam[]),
          ],
        }),
      },
    );

    // Inject cache_control on last content block of last message (after merge,
    // so it lands on the final tool_result block in the merged user message).
    injectCacheControlOnLastBlock(messages);

    // Build generation kwargs (excluding betaFeatures)
    const kwargs: Record<string, unknown> = {};
    if (this._generationKwargs.max_tokens !== undefined) {
      kwargs['max_tokens'] = this._generationKwargs.max_tokens;
    }
    if (this._generationKwargs.temperature !== undefined) {
      kwargs['temperature'] = this._generationKwargs.temperature;
    }
    if (this._generationKwargs.top_k !== undefined) {
      kwargs['top_k'] = this._generationKwargs.top_k;
    }
    if (this._generationKwargs.top_p !== undefined) {
      kwargs['top_p'] = this._generationKwargs.top_p;
    }
    const thinking = this._generationKwargs.thinking;
    if (thinking !== undefined) {
      kwargs['thinking'] = thinking;
    }
    if (this._generationKwargs.output_config !== undefined) {
      kwargs['output_config'] = this._generationKwargs.output_config;
    }
    applyResponseFormat(kwargs, options?.responseFormat);
    if (this._generationKwargs.contextManagement !== undefined) {
      kwargs['context_management'] = this._generationKwargs.contextManagement;
    }

    // Build the beta feature list. On the standard Messages API these travel
    // via the `anthropic-beta` header; on the beta Messages API (`betaApi`) the
    // SDK reads them from the request `betas` field and sets the header itself,
    // so we must not also set the header (that would duplicate it).
    const betas = this._generationKwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (!this._betaApi && betas.length > 0) {
      extraHeaders['anthropic-beta'] = betas.join(',');
    }

    // Convert tools
    const anthropicTools: AnthropicToolParam[] = tools.map((t) => convertTool(t));
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools.at(-1);
      if (lastTool !== undefined) {
        lastTool.cache_control = CACHE_CONTROL;
      }
    }

    // Build the create params
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      ...kwargs,
    };

    if (system !== undefined) {
      createParams['system'] = system;
    }

    if (anthropicTools.length > 0) {
      createParams['tools'] = anthropicTools;
    }

    if (this._metadata !== undefined) {
      createParams['metadata'] = this._metadata;
    }

    if (this._betaApi && betas.length > 0) {
      createParams['betas'] = betas;
    }

    const requestOptions: Record<string, unknown> = {};
    const headers = mergeRequestHeaders(extraHeaders, options?.auth?.headers);
    if (headers !== undefined) {
      requestOptions['headers'] = headers;
    }
    if (options?.signal) {
      requestOptions['signal'] = options.signal;
    }
    const finalRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
    const client = this._createClient(options?.auth);
    options?.onRequestSent?.();

    if (this._stream) {
      // Use the raw Messages stream instead of the SDK MessageStream helper.
      // The helper reparses accumulated input_json_delta buffers on every chunk,
      // which becomes synchronous O(n^2) work for large streamed tool arguments.
      try {
        const stream = this._betaApi
          ? await client.beta.messages.create(
              { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            )
          : await client.messages.create(
              { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            );
        return new AnthropicStreamedMessage(stream, true, this._convertErrorHook);
      } catch (error: unknown) {
        throw convertAnthropicError(error, this._convertErrorHook);
      }
    }

    // Non-streaming fallback
    try {
      const response = this._betaApi
        ? await client.beta.messages.create(
            { ...createParams, stream: false } as unknown as MessageCreateParams,
            finalRequestOptions,
          )
        : await client.messages.create(
            { ...createParams, stream: false } as unknown as MessageCreateParams,
            finalRequestOptions,
          );
      return new AnthropicStreamedMessage(response, false, this._convertErrorHook);
    } catch (error: unknown) {
      throw convertAnthropicError(error, this._convertErrorHook);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): Anthropic {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => this._buildClient(this._requireApiKey(a)),
    );
  }

  private _requireApiKey(auth: ProviderRequestAuth | undefined): string {
    const apiKey = auth?.apiKey ?? this._apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ChatProviderError(
        'AnthropicChatProvider: apiKey is required. Provide it via constructor options, options.auth.apiKey on each request, or an OAuth login. The Anthropic adapter does not read shell API-key environment variables.',
      );
    }
    return apiKey;
  }

  private _anthropicCustomHeaderEnvNames(): string[] {
    const customHeaders = process.env['ANTHROPIC_CUSTOM_HEADERS'];
    if (customHeaders === undefined || customHeaders.length === 0) return [];

    const names: string[] = [];
    for (const line of customHeaders.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex < 0) continue;

      const name = line.slice(0, colonIndex).trim().toLowerCase();
      if (name.length > 0) names.push(name);
    }
    return names;
  }

  private _buildDefaultHeaders(apiKey: string): Record<string, string | null> {
    const defaultHeaders: Record<string, string | null> = { authorization: null };
    for (const name of this._anthropicCustomHeaderEnvNames()) {
      defaultHeaders[name] = null;
    }
    for (const [name, value] of Object.entries(this._defaultHeaders ?? {})) {
      defaultHeaders[name.toLowerCase()] = value;
    }
    defaultHeaders['x-api-key'] = apiKey;
    return defaultHeaders;
  }

  // We use the Anthropic SDK purely as a transport to arbitrary
  // anthropic-compatible endpoints (`baseUrl` may point anywhere). Left to its
  // defaults the SDK auto-discovers credentials from the shell environment
  // (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS), which
  // would leak an out-of-band bearer/headers to a third-party endpoint even when
  // an explicit apiKey is set. So we hard-disable every auto-discovery channel.
  // These `null`s — and the nulled headers in _buildDefaultHeaders — are NOT
  // redundant: removing them reintroduces credential leakage. Regression cover:
  // test/e2e/anthropic-adapter.test.ts.
  private _buildClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this._baseUrl ?? null,
      defaultHeaders: this._buildDefaultHeaders(apiKey),
    });
  }

  withThinking(effort: ThinkingEffort): AnthropicChatProvider {
    const profile = resolveThinkingProfile(
      this._model,
      this._supportEfforts,
      this._kimiThinking ? true : this._adaptiveThinking,
    );
    let thinking: MessageCreateParams['thinking'];
    let outputConfig: MessageCreateParams['output_config'] | undefined;

    if (effort === 'off') {
      thinking = { type: 'disabled' };
    } else if (this._kimiThinking) {
      thinking = { type: 'enabled' } as MessageCreateParams['thinking'];
      outputConfig =
        effort === 'on' ? undefined : ({ effort } as MessageCreateParams['output_config']);
    } else if (profile.mode === 'adaptive') {
      thinking = { type: 'adaptive', display: 'summarized' };
      outputConfig =
        effort === 'on'
          ? undefined
          : ({ effort } as MessageCreateParams['output_config']);
    } else {
      const budgetTokens = budgetTokensForEffort(effort);
      thinking =
        budgetTokens === undefined
          ? ({ type: 'enabled' } as MessageCreateParams['thinking'])
          : { type: 'enabled', budget_tokens: budgetTokens };
      outputConfig =
        (profile.supportsEffortParam || budgetTokens === undefined) && effort !== 'on'
          ? ({ effort } as MessageCreateParams['output_config'])
          : undefined;
    }

    let newBetas = [...(this._generationKwargs.betaFeatures ?? [])];
    if (profile.mode === 'adaptive') {
      newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
    }
    const clone = this._withGenerationKwargs({
      thinking,
      betaFeatures: newBetas,
    });
    if (outputConfig !== undefined) {
      clone._generationKwargs.output_config = outputConfig;
    } else {
      delete clone._generationKwargs.output_config;
    }
    return clone;
  }

  withThinkingKeep(keep: string): AnthropicChatProvider {
    const current = this._generationKwargs.betaFeatures ?? [];
    const betaFeatures = current.includes(CONTEXT_MANAGEMENT_BETA)
      ? current
      : [...current, CONTEXT_MANAGEMENT_BETA];
    // Preserve any existing context-management edits (e.g. clear_tool_uses) and
    // keep clear_thinking first, as Anthropic requires when combining edits. Drop
    // a previous clear_thinking edit so re-applying stays idempotent.
    const existingEdits = this._generationKwargs.contextManagement?.edits ?? [];
    const edits = [
      { type: CLEAR_THINKING_EDIT, keep },
      ...existingEdits.filter((edit) => edit.type !== CLEAR_THINKING_EDIT),
    ];
    const clone = this._withGenerationKwargs({
      contextManagement: { edits },
      betaFeatures,
    });
    // clear_thinking_20251015 is honored only on the beta Messages API
    // (client.beta.messages.create), so enabling keep forces the beta endpoint
    // here even when the provider was constructed with betaApi: false. Setting
    // `[thinking] keep` to an off-value (or KIMI_MODEL_THINKING_KEEP=off) is the
    // escape hatch that disables keep and returns requests to the standard
    // endpoint. This also routes adaptive models (whose withThinking would
    // otherwise drop the interleaved-thinking beta and leave betaFeatures empty)
    // onto the beta endpoint with a body `betas=[context-management-...]`.
    clone._betaApi = true;
    return clone;
  }

  withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  withMaxCompletionTokens(maxCompletionTokens: number): AnthropicChatProvider {
    const requestedCap = resolveDefaultMaxTokens(this._model, maxCompletionTokens);
    const existingCap = this._generationKwargs.max_tokens;
    const clone = this._withGenerationKwargs({
      max_tokens:
        existingCap === undefined || this._explicitMaxTokens
          ? existingCap ?? requestedCap
          : Math.min(existingCap, requestedCap),
    });
    clone._explicitMaxTokens = this._explicitMaxTokens;
    return clone;
  }

  private _withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    if ('max_tokens' in kwargs) {
      clone._explicitMaxTokens = kwargs.max_tokens !== undefined;
    }
    return clone;
  }

  private _clone(): AnthropicChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as AnthropicChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
