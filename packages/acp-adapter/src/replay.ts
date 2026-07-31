import { type ContextMessage } from '@moonshot-ai/kimi-code-sdk';

/**
 * Parse a tool call's `arguments` field (kosong wire format: a JSON
 * string or `null`) into the structured object expected by the live
 * {@link toolCallStartToSessionUpdate} mapper. Falls back to the raw
 * string when the payload is not valid JSON — the mapper itself uses
 * {@link stringifyArgs}, which gracefully `String(x)`s anything it
 * cannot serialize, so the worst case is a degraded preview rather
 * than a crash.
 */
export function parseToolCallArguments(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments === '') return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

/**
 * Project a `tool` role {@link ContextMessage}'s `content` array into
 * the ACP `tool_call_update.content` shape (an array of
 * `ToolCallContent` entries). The historical message's content is a
 * sequence of kosong content parts — for replay we surface text parts
 * directly and stringify anything else (image refs etc.) as a
 * `[type]` placeholder so the client still sees that something was
 * returned.
 */
export function toolMessageContentToAcpToolCallContent(
  parts: ContextMessage['content'],
): Array<{ type: 'content'; content: { type: 'text'; text: string } }> {
  const result: Array<{ type: 'content'; content: { type: 'text'; text: string } }> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        result.push({ type: 'content', content: { type: 'text', text: part.text } });
      }
      continue;
    }
    // image_url / audio_url / video_url / think — surface a marker so
    // the result card is not empty. Replay should not lose evidence
    // that a non-text part was present.
    result.push({
      type: 'content',
      content: { type: 'text', text: `[${part.type}]` },
    });
  }
  return result;
}
