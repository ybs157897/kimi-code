import type { StreamedMessagePart, ThinkPart, ToolCall } from '#/message';
import type { FinishReason, StreamedMessage } from '#/provider';
import type { TokenUsage } from '#/usage';
import { createAbortError } from './google-genai-abort';
import { convertGoogleGenAIError } from './google-genai-errors';

/**
 * Normalize a Google GenAI (Gemini) `finishReason` value to the unified
 * {@link FinishReason} enum.
 *
 * Source: `candidates[0].finishReason` (works for both stream and
 * non-stream — the SDK normalizes them). Gemini does not emit a
 * `tool_calls`-style reason; tool calls come via `parts[].functionCall`
 * and `finishReason` stays `'completed'` even when the model produces
 * function calls.
 */
function normalizeGoogleGenAIFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  // The SDK normally hands us a plain string but older builds wrap it in
  // an enum-like object. Accept both shapes and uppercase to match the
  // documented constants. Anything else collapses to "no signal" so we
  // never emit a junk `[object Object]` raw value.
  let rawString: string;
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase();
  } else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
    rawString = String(raw).toUpperCase();
  } else {
    return { finishReason: null, rawFinishReason: null };
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (rawString) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: rawString };
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: rawString };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { finishReason: 'filtered', rawFinishReason: rawString };
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
    case 'LANGUAGE':
      return { finishReason: 'other', rawFinishReason: rawString };
    default:
      return { finishReason: 'other', rawFinishReason: rawString };
  }
}
export class GoogleGenAIStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: AsyncIterable<Record<string, unknown>> | Record<string, unknown>,
    isStream: boolean,
    signal?: AbortSignal,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<Record<string, unknown>>,
        signal,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as Record<string, unknown>, signal);
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(response: Record<string, unknown>): void {
    const candidates = response['candidates'] as unknown[] | undefined;
    if (!candidates || candidates.length === 0) {
      return;
    }
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (first === undefined) {
      return;
    }
    const raw = first['finishReason'] ?? first['finish_reason'];
    if (raw === undefined) {
      return;
    }
    const normalized = normalizeGoogleGenAIFinishReason(raw);
    // Only overwrite when we got a definitive signal — early stream
    // chunks may contain `FINISH_REASON_UNSPECIFIED` while the model is
    // still generating, and we treat those as "not yet known".
    if (normalized.finishReason !== null || normalized.rawFinishReason !== null) {
      this._finishReason = normalized.finishReason;
      this._rawFinishReason = normalized.rawFinishReason;
    }
  }

  /** Yield parts from a single (non-streamed) GenerateContentResponse. */
  private _extractChunkParts(response: Record<string, unknown>): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];

    const candidates = response['candidates'] as unknown[] | undefined;
    for (const candidate of candidates ?? []) {
      const cand = candidate as Record<string, unknown>;
      const content = cand['content'] as Record<string, unknown> | undefined;
      const contentParts = content?.['parts'] as unknown[] | undefined;
      if (!contentParts) continue;

      for (const part of contentParts) {
        const p = part as Record<string, unknown>;
        if (p['thought'] === true && typeof p['text'] === 'string') {
          const thoughtSignature = p['thoughtSignature'] ?? p['thought_signature'];
          const thinkPart: ThinkPart = { type: 'think', think: p['text'] };
          if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0) {
            thinkPart.encrypted = thoughtSignature;
          }
          parts.push(thinkPart);
        } else if (p['text']) {
          parts.push({ type: 'text', text: p['text'] as string });
        } else if (p['functionCall'] || p['function_call']) {
          const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
          const name = fc['name'] as string;
          if (!name) continue;
          // The upstream function-call id is only unique within its own
          // response (some backends re-issue small ids like "0" every turn),
          // so `${name}_${id}` collided across turns — two AgentSwarm calls in
          // different turns both became `AgentSwarm_0` and the web client
          // merged their member lists into one card. Append entropy so ids
          // stay unique across the whole session.
          const id_ = (fc['id'] as string) ?? crypto.randomUUID();
          const toolCallId = `${name}_${id_}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
          const thoughtSigB64 = p['thoughtSignature'] ?? p['thought_signature'];
          const toolCall: ToolCall = {
            type: 'function',
            id: toolCallId,
            name,
            arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
          };
          if (typeof thoughtSigB64 === 'string' && thoughtSigB64.length > 0) {
            toolCall.extras = { thought_signature_b64: thoughtSigB64 };
          }
          parts.push(toolCall);
        }
      }
    }

    return parts;
  }

  /** Extract usage metadata from a response chunk. */
  private _extractUsage(response: Record<string, unknown>): void {
    const usageMetadata = response['usageMetadata'] as Record<string, unknown> | undefined;
    if (usageMetadata) {
      const promptTokenCount =
        typeof usageMetadata['promptTokenCount'] === 'number'
          ? usageMetadata['promptTokenCount']
          : 0;
      const cachedContentTokenCount =
        typeof usageMetadata['cachedContentTokenCount'] === 'number'
          ? usageMetadata['cachedContentTokenCount']
          : 0;
      this._usage = {
        inputOther: Math.max(promptTokenCount - cachedContentTokenCount, 0),
        output: (usageMetadata['candidatesTokenCount'] as number) ?? 0,
        inputCacheRead: cachedContentTokenCount,
        inputCacheCreation: 0,
      };
    }
  }

  /** Extract response ID from a response chunk. */
  private _extractId(response: Record<string, unknown>): void {
    if (response['responseId'] !== undefined) {
      this._id = response['responseId'] as string;
    }
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    // Helper kept small so TypeScript's control-flow narrowing does not
    // collapse `signal.aborted` to `false | undefined` at call sites that
    // check the signal repeatedly between async steps.
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(signal);
    this._extractUsage(response);
    this._extractId(response);
    this._captureFinishReason(response);
    for (const part of this._extractChunkParts(response)) {
      this._throwIfAborted(signal);
      yield part;
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        // Check abort at each chunk boundary so users who pass an
        // AbortSignal see cancellation honored promptly even though the
        // Google GenAI SDK does not forward it to the underlying fetch.
        this._throwIfAborted(signal);
        this._extractUsage(chunk);
        this._extractId(chunk);
        this._captureFinishReason(chunk);
        for (const part of this._extractChunkParts(chunk)) {
          this._throwIfAborted(signal);
          yield part;
        }
      }
    } catch (error: unknown) {
      // Preserve AbortError identity so the retry/generate loop can
      // distinguish it from transient provider errors.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }
}
