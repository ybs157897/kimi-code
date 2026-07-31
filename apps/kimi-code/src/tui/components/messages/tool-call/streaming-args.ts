/**
 * Partial-JSON helpers for streamed tool arguments: pull live field values
 * out of an incomplete argument buffer and parse a best-effort preview.
 */

import {
  STREAMING_ARGS_FIELD_RE,
  STREAMING_ARGS_PREVIEW_MAX_CHARS,
} from '#/tui/constant/streaming';

function unescapeJsonString(s: string): string {
  return s.replaceAll(/\\(["\\/bfnrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      default:
        return ch;
    }
  });
}

/**
 * Pull the live value of a JSON string field out of partially-streamed
 * arguments, even if the closing quote hasn't arrived yet. Handles the
 * common JSON string escapes so `\n` in a streamed `content` becomes a
 * real newline we can highlight. Returns `undefined` if the field hasn't
 * started streaming yet.
 */
export function extractPartialStringField(text: string, key: string): string | undefined {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = opener.exec(text);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let out = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return out;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'u': {
          if (i + 5 >= text.length) return out;
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) return out;
          out += String.fromCodePoint(code);
          i += 6;
          continue;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
  return out;
}

export function parseArgsPreview(value: string): Record<string, unknown> {
  const previewText = value.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (previewText.trim().length === 0) return {};
  if (
    value.length <= STREAMING_ARGS_PREVIEW_MAX_CHARS &&
    previewText.trimEnd().endsWith('}')
  ) {
    try {
      const parsed = JSON.parse(previewText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to partial scan
    }
  }
  const result: Record<string, unknown> = {};
  for (const match of previewText.matchAll(STREAMING_ARGS_FIELD_RE)) {
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (!(key in result)) result[key] = unescapeJsonString(rawValue);
  }
  return result;
}
