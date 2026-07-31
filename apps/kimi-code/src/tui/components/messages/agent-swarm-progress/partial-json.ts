/**
 * Minimal partial-JSON string parsing for streaming agent-swarm arguments.
 */

export function countPartialJsonObjectEntries(text: string, startIndex: number): number {
  let count = 0;
  let expectKey = true;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '}') return count;
    if (ch === ',') {
      expectKey = true;
      continue;
    }
    if (ch !== '"') continue;

    const parsed = parsePartialJsonString(text, i + 1);
    if (expectKey) {
      if (parsed.closed || parsed.value.length > 0) count += 1;
      expectKey = false;
    }
    if (!parsed.closed) return count;
    i = parsed.nextIndex;
  }
  return count;
}

export function parsePartialJsonString(
  text: string,
  startIndex: number,
): { value: string; closed: boolean; nextIndex: number } {
  let value = '';
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return { value, closed: true, nextIndex: i };
    if (ch !== '\\') {
      value += ch;
      continue;
    }

    const escaped = text[i + 1];
    if (escaped === undefined) return { value, closed: false, nextIndex: i };
    switch (escaped) {
      case 'n': value += '\n'; break;
      case 't': value += '\t'; break;
      case 'r': value += '\r'; break;
      case 'b': value += '\b'; break;
      case 'f': value += '\f'; break;
      case '"':
      case '\\':
      case '/':
        value += escaped;
        break;
      case 'u': {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) return { value, closed: false, nextIndex: i };
        const code = Number.parseInt(hex, 16);
        if (Number.isNaN(code)) return { value, closed: false, nextIndex: i };
        value += String.fromCodePoint(code);
        i += 4;
        break;
      }
      default:
        value += escaped;
    }
    i += 1;
  }
  return { value, closed: false, nextIndex: text.length };
}
