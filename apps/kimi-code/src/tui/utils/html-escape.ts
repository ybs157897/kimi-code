// apps/kimi-code/src/tui/utils/html-escape.ts
// Shared HTML attribute escaping for TUI media/tag rendering.

/** Escape the four HTML-significant characters for safe use inside a
 *  double-quoted attribute value (`"` delimited). Single quotes are NOT
 *  escaped — the callers always use double-quoted attributes. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
