import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
  throwIfAbortError,
} from '#/errors';
import {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  AnthropicError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
} from '@anthropic-ai/sdk';

export function convertAnthropicError(
  error: unknown,
  convertErrorHook?: (error: unknown) => ChatProviderError | undefined,
): ChatProviderError {
  // Abort guard FIRST: throws (never returns) the standard abort DOMException
  // for any abort shape, so a user cancellation is never misclassified as a
  // retryable provider failure.
  throwIfAbortError(error);
  if (error instanceof ChatProviderError) {
    return error;
  }
  const converted = convertErrorHook?.(error);
  if (converted !== undefined) {
    return converted;
  }
  // Check timeout before connection (APIConnectionTimeoutError extends APIConnectionError)
  if (error instanceof AnthropicTimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof AnthropicConnectionError) {
    return new APIConnectionError(error.message);
  }
  // APIError with a status code => status error
  if (error instanceof AnthropicAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(
      error.status,
      error.message,
      reqId,
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof AnthropicError) {
    return new ChatProviderError(`Anthropic error: ${error.message}`);
  }
  // Raw, non-SDK errors (e.g. undici's `TypeError: terminated` raised when a
  // streaming response body is dropped mid-flight) are never wrapped by the
  // Anthropic SDK during stream iteration. Route them through the shared
  // transport-layer heuristic so genuine connection failures become retryable
  // instead of fatal generic errors.
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}
