/**
 * Codex marked-directive tokenizer + classifier.
 * Fail-soft: bad attrs / unknown names never throw.
 */

import { attrBool, attrNumber, attrString, parseDirectiveAttrs, type DirectiveAttrs } from './attrs';
import type { GithubAlertType } from './preprocess';

export const HIDDEN_DIRECTIVES = new Set([
  'git-stage',
  'git-commit',
  'git-create-branch',
  'git-push',
  'git-create-pr',
  'code-comment',
  'inbox-item',
  'archive-thread',
  'created-thread',
  'pr-auto-fix-progress',
  'codex-realtime-inline',
  'codex-live-vis',
]);

export const VISIBLE_DIRECTIVES = new Set([
  'github-details',
  'github-alert',
  'codex-file-citation',
  'task-stub',
  'artifact-template',
  'codex-inline-vis',
  'writing',
  'automation-citation',
]);

export type DirectiveKind = 'hidden' | 'visible' | 'unknown';

export function classifyDirective(name: string): DirectiveKind {
  if (HIDDEN_DIRECTIVES.has(name)) return 'hidden';
  if (VISIBLE_DIRECTIVES.has(name)) return 'visible';
  return 'unknown';
}

export interface ParsedDirectiveHeader {
  name: string;
  attrs: DirectiveAttrs;
  /** Container uses ::: ; leaf uses :: */
  container: boolean;
  /** Raw matched header line without trailing newline */
  rawHeader: string;
}

const HEADER_RE = /^(:{2,3})([A-Za-z0-9_-]+)(?:\{([^}]*)\})?[ \t]*$/;

export function parseDirectiveHeader(line: string): ParsedDirectiveHeader | null {
  try {
    const trimmed = line.replace(/\r$/, '');
    const m = HEADER_RE.exec(trimmed);
    if (!m) return null;
    const colons = m[1]!;
    if (colons.length < 2 || colons.length > 3) return null;
    const name = m[2]!;
    const attrs = parseDirectiveAttrs(m[3]);
    return {
      name,
      attrs,
      container: colons.length === 3,
      rawHeader: trimmed,
    };
  } catch {
    return null;
  }
}

export type CodexSegment =
  | { kind: 'md'; text: string }
  | { kind: 'diff'; code: string }
  | { kind: 'hidden' }
  | { kind: 'raw'; text: string }
  | { kind: 'details'; summary: string; open: boolean; body: string }
  | { kind: 'alert'; type: GithubAlertType; body: string }
  | {
      kind: 'citation';
      path: string;
      line?: number;
      endLine?: number;
      label?: string;
      purpose?: string;
    }
  | { kind: 'task-stub'; title: string; body: string }
  | {
      kind: 'writing';
      id?: string;
      title?: string;
      variant?: string;
      recipient?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      body: string;
    }
  | {
      kind: 'artifact';
      artifactKind?: string;
      displayName?: string;
      skillName?: string;
    }
  | { kind: 'automation'; automationId: string; index?: string }
  | {
      kind: 'inline-vis';
      file?: string;
      title?: string;
      expandable?: boolean;
    };

const DIFF_FENCE_RE = /(^|\n)(?:```|~~~)diff\b[^\n]*\n([\s\S]*?)(?:\n)?(?:```|~~~)(?=\n|$)/g;
const ANY_FENCE_OPEN_RE = /^(```|~~~)/;

function pushMd(out: CodexSegment[], text: string): void {
  if (!text) return;
  // Avoid empty-only segments except when it's the sole content.
  if (!text.trim() && out.length > 0) {
    const last = out[out.length - 1];
    if (last?.kind === 'md') {
      last.text += text;
      return;
    }
  }
  out.push({ kind: 'md', text });
}

function toVisibleSegment(header: ParsedDirectiveHeader, body: string, raw: string): CodexSegment {
  const { name, attrs } = header;
  switch (name) {
    case 'github-details':
      return {
        kind: 'details',
        summary: attrString(attrs, 'summary') ?? '',
        open: attrBool(attrs, 'open'),
        body,
      };
    case 'github-alert': {
      const typeRaw = (attrString(attrs, 'type') ?? 'NOTE').toUpperCase();
      const type = (
        ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].includes(typeRaw) ? typeRaw : 'NOTE'
      ) as GithubAlertType;
      return { kind: 'alert', type, body };
    }
    case 'codex-file-citation': {
      const path = attrString(attrs, 'path') ?? '';
      const start = attrNumber(attrs, 'line_range_start');
      const end = attrNumber(attrs, 'line_range_end');
      return {
        kind: 'citation',
        path,
        line: start,
        endLine: end,
        label: attrString(attrs, 'label'),
        purpose: attrString(attrs, 'purpose'),
      };
    }
    case 'task-stub':
      return {
        kind: 'task-stub',
        title: attrString(attrs, 'title') ?? '',
        body,
      };
    case 'writing':
      return {
        kind: 'writing',
        id: attrString(attrs, 'id'),
        title: attrString(attrs, 'title'),
        variant: attrString(attrs, 'variant'),
        recipient: attrString(attrs, 'recipient'),
        cc: attrString(attrs, 'cc'),
        bcc: attrString(attrs, 'bcc'),
        subject: attrString(attrs, 'subject'),
        body,
      };
    case 'artifact-template':
      return {
        kind: 'artifact',
        artifactKind: attrString(attrs, 'artifact_kind'),
        displayName: attrString(attrs, 'display_name'),
        skillName: attrString(attrs, 'skill_name'),
      };
    case 'automation-citation':
      return {
        kind: 'automation',
        automationId: attrString(attrs, 'automation_id') ?? '',
        index: attrString(attrs, 'index'),
      };
    case 'codex-inline-vis':
      return {
        kind: 'inline-vis',
        file: attrString(attrs, 'file'),
        title: attrString(attrs, 'title'),
        expandable: attrBool(attrs, 'expandable'),
      };
    default:
      return { kind: 'raw', text: raw };
  }
}

/**
 * Leaf directives that carry a following body until a blank line / next directive / EOF.
 * Codex uses `::task-stub` with a prompt body on subsequent lines.
 */
const LEAF_WITH_BODY = new Set(['task-stub']);

function takeLeafBody(lines: string[], startIdx: number): { body: string; nextIdx: number } {
  const parts: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') break;
    if (parseDirectiveHeader(line)) break;
    if (ANY_FENCE_OPEN_RE.test(line.trimStart())) break;
    parts.push(line);
    i++;
  }
  return { body: parts.join('\n'), nextIdx: i };
}

function takeContainerBody(
  lines: string[],
  startIdx: number,
): { body: string; nextIdx: number; closed: boolean } {
  const parts: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^:::[ \t]*$/.test(line.replace(/\r$/, ''))) {
      return { body: parts.join('\n'), nextIdx: i + 1, closed: true };
    }
    parts.push(line);
    i++;
  }
  return { body: parts.join('\n'), nextIdx: i, closed: false };
}

/** Split preprocessed markdown into render segments (directives / diff / md). */
export function segmentCodexMarkdown(src: string): CodexSegment[] {
  const out: CodexSegment[] = [];
  if (!src) {
    out.push({ kind: 'md', text: '' });
    return out;
  }

  // First peel ```diff fences (same contract as Markdown.vue historically).
  const pieces: Array<{ type: 'text'; text: string } | { type: 'diff'; code: string }> = [];
  let last = 0;
  DIFF_FENCE_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = DIFF_FENCE_RE.exec(src)) !== null) {
    const lead = dm[1] ?? '';
    const before = src.slice(last, dm.index) + (lead || '');
    if (before) pieces.push({ type: 'text', text: before });
    pieces.push({ type: 'diff', code: dm[2] ?? '' });
    last = DIFF_FENCE_RE.lastIndex;
  }
  const tail = src.slice(last);
  if (tail || pieces.length === 0) pieces.push({ type: 'text', text: tail });

  for (const piece of pieces) {
    if (piece.type === 'diff') {
      out.push({ kind: 'diff', code: piece.code });
      continue;
    }
    segmentDirectives(piece.text, out);
  }

  if (out.length === 0) out.push({ kind: 'md', text: '' });
  return out;
}

function segmentDirectives(text: string, out: CodexSegment[]): void {
  const lines = text.split('\n');
  let buf: string[] = [];
  let i = 0;

  const flushBuf = () => {
    if (buf.length === 0) return;
    pushMd(out, buf.join('\n'));
    buf = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Preserve fence blocks intact inside md (don't parse directives inside).
    const fenceOpen = line.trimStart().match(/^(```|~~~)/);
    if (fenceOpen) {
      const marker = fenceOpen[1]!;
      buf.push(line);
      i++;
      while (i < lines.length) {
        buf.push(lines[i] ?? '');
        if ((lines[i] ?? '').trimStart().startsWith(marker)) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    const header = parseDirectiveHeader(line);
    if (!header) {
      buf.push(line);
      i++;
      continue;
    }

    flushBuf();
    i++;

    try {
      const kind = classifyDirective(header.name);
      if (header.container) {
        const { body, nextIdx, closed } = takeContainerBody(lines, i);
        i = nextIdx;
        const raw = closed
          ? `${header.rawHeader}\n${body}\n:::`
          : `${header.rawHeader}\n${body}`;

        // Streaming incomplete containers for inline-vis → hide.
        if (!closed && header.name === 'codex-inline-vis') {
          out.push({ kind: 'hidden' });
          continue;
        }
        if (!closed && kind === 'hidden') {
          out.push({ kind: 'hidden' });
          continue;
        }
        if (kind === 'hidden') {
          out.push({ kind: 'hidden' });
          continue;
        }
        if (kind === 'unknown') {
          out.push({ kind: 'raw', text: raw });
          continue;
        }
        out.push(toVisibleSegment(header, body, raw));
        continue;
      }

      // Leaf ::name{attrs}
      let body = '';
      if (LEAF_WITH_BODY.has(header.name)) {
        const taken = takeLeafBody(lines, i);
        body = taken.body;
        i = taken.nextIdx;
      }
      const raw = body ? `${header.rawHeader}\n${body}` : header.rawHeader;

      if (kind === 'hidden') {
        out.push({ kind: 'hidden' });
        continue;
      }
      if (kind === 'unknown') {
        out.push({ kind: 'raw', text: raw });
        continue;
      }
      out.push(toVisibleSegment(header, body, raw));
    } catch {
      out.push({ kind: 'raw', text: line });
    }
  }

  flushBuf();
}
