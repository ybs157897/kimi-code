import type { MarkdownIt } from 'markstream-vue';

/**
 * Codex-aligned markdown-it tweaks for markstream:
 * - soft breaks (`breaks: true`)
 * - keep block math (`$$` / `\[…\]`) from the built-in plugin
 * - disable dollar inline math (avoids `$PATH` false positives)
 * - enable `\(...\)` inline math only
 */
export function configureCodexMarkdownIt(md: MarkdownIt): MarkdownIt {
  md.set({ breaks: true });
  md.inline.ruler.disable('math');
  md.inline.ruler.before('escape', 'codex_math_paren', parenInlineMath);
  return md;
}

/** Match `\(...\)` on a single line (Codex: inline math must not span lines). */
function parenInlineMath(
  state: {
    src: string;
    pos: number;
    posMax: number;
    push: (type: string, tag: string, nesting: number) => { content: string; markup: string; raw?: string };
  },
  silent: boolean,
): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.slice(start, start + 2) !== '\\(') return false;

  const close = src.indexOf('\\)', start + 2);
  if (close === -1 || close > state.posMax) return false;
  const content = src.slice(start + 2, close);
  if (content.includes('\n') || content.includes('\r')) return false;

  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = '\\(\\)';
    token.raw = `\\(${content}\\)`;
  }
  state.pos = close + 2;
  return true;
}
