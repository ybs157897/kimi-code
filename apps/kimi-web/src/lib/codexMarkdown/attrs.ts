/** Parse Codex-style directive attribute bags: `key=value`, quoted strings, flags, numbers. */

export type DirectiveAttrs = Record<string, string | boolean | number>;

export function parseDirectiveAttrs(raw: string | undefined): DirectiveAttrs {
  if (!raw) return {};
  const attrs: DirectiveAttrs = {};
  const src = raw.trim();
  if (!src) return attrs;

  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) break;

    const keyStart = i;
    while (i < src.length && /[A-Za-z0-9_-]/.test(src[i]!)) i++;
    if (i === keyStart) {
      // Skip one char on parse failure (fail-soft).
      i++;
      continue;
    }
    const key = src.slice(keyStart, i);

    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '=') {
      attrs[key] = true;
      continue;
    }
    i++; // =
    while (i < src.length && /\s/.test(src[i]!)) i++;

    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]!;
      i++;
      let value = '';
      while (i < src.length) {
        const ch = src[i]!;
        if (ch === '\\' && i + 1 < src.length) {
          value += src[i + 1]!;
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        value += ch;
        i++;
      }
      attrs[key] = value;
      continue;
    }

    const valStart = i;
    while (i < src.length && !/\s/.test(src[i]!)) i++;
    const token = src.slice(valStart, i);
    if (token === 'true') attrs[key] = true;
    else if (token === 'false') attrs[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(token)) attrs[key] = Number(token);
    else attrs[key] = token;
  }

  return attrs;
}

export function attrString(attrs: DirectiveAttrs, key: string): string | undefined {
  const v = attrs[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return undefined;
}

export function attrBool(attrs: DirectiveAttrs, key: string): boolean {
  const v = attrs[key];
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return Boolean(v);
}

export function attrNumber(attrs: DirectiveAttrs, key: string): number | undefined {
  const v = attrs[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
