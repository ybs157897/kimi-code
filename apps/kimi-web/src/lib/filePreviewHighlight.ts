/**
 * Shiki-based syntax highlighting for the file preview pane.
 * Lazily loads languages; returns null when highlighting is skipped/fails so
 * the UI can fall back to escaped plain text.
 */

import { createHighlighter, type BundledLanguage, type Highlighter } from 'shiki';

import { escapeHtml } from './searchHighlight';

export type FilePreviewTheme = 'github-light' | 'github-dark';

const HEAVY_CHARS = 200_000;
const HEAVY_LINES = 8_000;

/** Map daemon languageId / file extension → Shiki bundled language id. */
const LANG_ALIASES: Record<string, string> = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  htm: 'html',
  svg: 'xml',
  toml: 'toml',
  jsonc: 'json',
  json5: 'json',
};

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: [],
  });
  return highlighterPromise;
}

export function resolveShikiLang(languageId: string): string {
  const raw = languageId.trim().toLowerCase();
  if (!raw) return '';
  return LANG_ALIASES[raw] ?? raw;
}

async function ensureLanguage(hl: Highlighter, lang: string): Promise<string | null> {
  if (!lang) return null;
  const loaded = hl.getLoadedLanguages() as string[];
  if (loaded.includes(lang)) return lang;
  try {
    await hl.loadLanguage(lang as BundledLanguage);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Highlight `code` into one HTML string per line (colored spans).
 * Returns null when the file is too large, the language is unknown, or Shiki fails.
 */
export async function highlightSourceLines(
  code: string,
  languageId: string,
  theme: FilePreviewTheme,
): Promise<string[] | null> {
  if (!code) return [];
  const lineCount = code.split('\n').length;
  if (code.length >= HEAVY_CHARS || lineCount >= HEAVY_LINES) return null;

  const lang = resolveShikiLang(languageId);
  if (!lang) return null;

  try {
    const hl = await getHighlighter();
    const resolved = await ensureLanguage(hl, lang);
    if (!resolved) return null;

    const { tokens } = hl.codeToTokens(code, { lang: resolved as BundledLanguage, theme });
    return tokens.map((line) => {
      if (line.length === 0) return '';
      return line
        .map((tok) => {
          const color = tok.color ? ` style="color:${tok.color}"` : '';
          return `<span${color}>${escapeHtml(tok.content)}</span>`;
        })
        .join('');
    });
  } catch {
    return null;
  }
}
