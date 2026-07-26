/**
 * Preprocess assistant Markdown for Codex Desktop compatibility:
 * strip comments, protect fences, convert <details> and GitHub alerts.
 */

const FENCE_RE = /(^|\n)(```|~~~)([^\n]*)\n([\s\S]*?)(?:\n)?\2(?=\n|$)/g;

const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type GithubAlertType = (typeof ALERT_TYPES)[number];

const ALERT_RE = new RegExp(
  String.raw`(^|\n)(>?\s*)\[!(${ALERT_TYPES.join('|')})\][ \t]*\r?\n((?:>?[ \t]?.*(?:\r?\n|$))*)`,
  'gi',
);

function protectFences(src: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const text = src.replace(FENCE_RE, (full, lead: string) => {
    const idx = fences.length;
    fences.push(full.slice(lead.length));
    return `${lead}\0FENCE${idx}\0`;
  });
  return { text, fences };
}

function restoreFences(text: string, fences: string[]): string {
  return text.replace(/\0FENCE(\d+)\0/g, (_, n: string) => fences[Number(n)] ?? '');
}

function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Convert <details><summary>…</summary>…</details> → :::github-details */
function convertDetails(src: string): string {
  return src.replace(
    /<details(\s[^>]*)?>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
    (_full, detailAttrs: string | undefined, summaryHtml: string, body: string) => {
      const summary = summaryHtml.replace(/<[^>]+>/g, '').trim();
      const open = /\bopen\b/i.test(detailAttrs ?? '') ? ' open="true"' : '';
      return `\n:::github-details{summary="${escapeAttr(summary)}"${open}}\n${body.trim()}\n:::\n`;
    },
  );
}

/**
 * Convert `> [!NOTE]` GitHub alerts into `:::github-alert{type="NOTE"}` containers.
 * Leading `>` markers on body lines are stripped.
 */
function convertAlerts(src: string): string {
  return src.replace(ALERT_RE, (_full, lead: string, _prefix: string, type: string, body: string) => {
    const lines = body
      .split(/\r?\n/)
      .map((line) => line.replace(/^>\s?/, ''))
      // Drop trailing empty lines that belonged to the blockquote run.
      .filter((line, i, arr) => !(line === '' && i === arr.length - 1));
    // Stop the alert body before a non-blockquote blank that ends the alert —
    // body already captured contiguous `>` lines via the regex; trim empties.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const content = lines.join('\n').trimEnd();
    return `${lead}:::github-alert{type="${type.toUpperCase()}"}\n${content}\n:::\n`;
  });
}

export function preprocessCodexMarkdown(src: string): string {
  if (!src) return src;
  const { text: protectedText, fences } = protectFences(src);
  let next = stripHtmlComments(protectedText);
  next = convertDetails(next);
  next = convertAlerts(next);
  return restoreFences(next, fences);
}
