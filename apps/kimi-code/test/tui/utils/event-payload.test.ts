/**
 * Scenario: TUI event payload helpers format bounded tool arguments and
 * runtime-neutral structured errors. Responsibilities: preserve legacy and
 * v2 error display while rejecting malformed lookalikes.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/utils/event-payload.test.ts
 */

import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import {
  appendStreamingArgsPreview,
  formatErrorMessage,
  formatErrorPayload,
  parseStreamingArgs,
} from '#/tui/utils/event-payload';

describe('streaming tool argument payload helpers', () => {
  it('parses complete JSON arguments for finalized small previews', () => {
    expect(parseStreamingArgs('{"command":"echo hi","path":"/tmp/a"}')).toEqual({
      command: 'echo hi',
      path: '/tmp/a',
    });
  });

  it('caps accumulated streaming preview text', () => {
    const current = 'a'.repeat(STREAMING_ARGS_PREVIEW_MAX_CHARS - 2);

    expect(appendStreamingArgsPreview(current, 'bcdef')).toBe(`${current}bc`);
  });

  it('parses only bounded preview fields from oversized streaming arguments', () => {
    const oversized = `{"command":"echo ok","description":"${'x'.repeat(
      STREAMING_ARGS_PREVIEW_MAX_CHARS + 100,
    )}"}`;

    expect(parseStreamingArgs(oversized)).toEqual({ command: 'echo ok' });
  });
});

describe('error payload formatting', () => {
  const filteredThinkOnlyMessage =
    'The API returned a response containing only thinking content without any text or tool calls. ' +
    'This usually indicates the stream was interrupted or the output token budget was exhausted ' +
    'during reasoning. Provider stop details: finishReason=filtered, rawFinishReason=content_filter. ' +
    'The provider filtered the response before visible output was emitted. Provider: example-provider, model: example-model';
  const conciseFilteredMessage =
    '[provider.api_error] Provider filtered the response before visible output ' +
    '(finishReason=filtered, rawFinishReason=content_filter).';

  it('shows concise provider filter text from structured error payload details', () => {
    const formatted = formatErrorPayload({
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: filteredThinkOnlyMessage,
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    });

    expect(formatted).toBe(conciseFilteredMessage);
    expect(formatted).not.toContain('only thinking content');
    expect(formatted).not.toContain('token budget');
    expect(formatted).not.toContain('stream was interrupted');
  });

  it('shows concise provider filter text from KimiError details', () => {
    const error = new KimiError(ErrorCodes.PROVIDER_API_ERROR, filteredThinkOnlyMessage, {
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    });

    expect(formatErrorMessage(error)).toBe(conciseFilteredMessage);
  });

  it('shows concise provider filter text from a structured v2 error', () => {
    const error = {
      code: 'provider.api_error',
      message: filteredThinkOnlyMessage,
      details: {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      },
    };

    expect(formatErrorMessage(error)).toBe(conciseFilteredMessage);
  });

  it('returns the message from an ordinary Error', () => {
    expect(formatErrorMessage(new Error('Example failure'))).toBe('Example failure');
  });

  it('returns a thrown string unchanged', () => {
    expect(formatErrorMessage('Example failure')).toBe('Example failure');
  });

  it.each([
    ['empty code', { code: '', message: 'Example failure' }],
    ['whitespace-only code', { code: '  ', message: 'Example failure' }],
    ['non-string code', { code: 500, message: 'Example failure' }],
    ['non-string message', { code: 'request.invalid', message: 500 }],
    ['null details', { code: 'request.invalid', message: 'Example failure', details: null }],
    ['array details', { code: 'request.invalid', message: 'Example failure', details: [] }],
  ])('stringifies a malformed structured error with %s', (_case, error) => {
    expect(formatErrorMessage(error)).toBe('[object Object]');
  });
});
