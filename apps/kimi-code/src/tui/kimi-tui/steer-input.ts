/**
 * Flatten queued steer input into the payload `session.steer` expects.
 */

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type { SteerInputItem } from '#/tui/types';

/**
 * Flatten steer items into the payload `session.steer` expects: the
 * historical `'\n\n'`-joined string when nothing carries media, or a
 * merged part list when any item has extracted media parts (queued image
 * messages, or the editor draft after placeholder extraction).
 *
 * Items are separated by the historical `'\n\n'`, which merges into the
 * adjacent text part. The one exception is two touching media parts: a
 * standalone `{type:'text',text:'\n\n'}` between them would be rejected
 * by `normalizePromptInput` as an empty text part, so the separator is
 * dropped there (media parts are self-delimiting anyway).
 */
export function combineSteerInput(items: readonly SteerInputItem[]): string | PromptPart[] {
  const hasMedia = items.some((item) => item.parts !== undefined && item.parts.length > 0);
  if (!hasMedia) return items.map((item) => item.text).join('\n\n');
  const parts: PromptPart[] = [];
  for (const item of items) {
    const startsWithMedia =
      item.parts !== undefined && item.parts.length > 0 && item.parts[0]?.type !== 'text';
    const lastIsMedia = parts.length > 0 && parts.at(-1)?.type !== 'text';
    if (parts.length > 0 && !(lastIsMedia && startsWithMedia)) {
      appendSteerText(parts, '\n\n');
    }
    if (item.parts !== undefined && item.parts.length > 0) {
      for (const part of item.parts) {
        if (part.type === 'text') appendSteerText(parts, part.text);
        else parts.push(part);
      }
    } else {
      appendSteerText(parts, item.text);
    }
  }
  return parts;
}

function appendSteerText(parts: PromptPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + text };
    return;
  }
  parts.push({ type: 'text', text });
}
