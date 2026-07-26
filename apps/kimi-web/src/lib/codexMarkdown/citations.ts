/** Codex citation literals: 【path†L12】 / 【path†L12-L40】 / 【F:encoded†L…】 */

export interface CodexCitation {
  path: string;
  line?: number;
  endLine?: number;
  raw: string;
  start: number;
  end: number;
}

// Fullwidth brackets around path†L{start}(-L{end})?
const CITATION_RE = /【([^】]*?)†L(\d+)(?:-L(\d+))?】/g;

function looksLikeLocalPath(path: string): boolean {
  if (!path) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (/^(www\.|mailto:|tel:)/i.test(path)) return false;
  return /[/\\.]/.test(path) || /^[A-Za-z0-9_.@+-]+$/.test(path);
}

export function parseCodexCitationLiteral(raw: string): Omit<CodexCitation, 'start' | 'end' | 'raw'> | null {
  CITATION_RE.lastIndex = 0;
  const m = CITATION_RE.exec(raw);
  if (!m || m.index !== 0 || m[0] !== raw) return null;
  return citationFromMatch(m);
}

function citationFromMatch(m: RegExpExecArray): Omit<CodexCitation, 'start' | 'end' | 'raw'> | null {
  let pathPart = (m[1] ?? '').trim();
  if (!pathPart) return null;

  let path: string;
  if (pathPart.startsWith('F:')) {
    // Codex uses decodeURI; we prefer decodeURIComponent so `%2F` becomes `/`.
    const encoded = pathPart.slice(2);
    try {
      path = decodeURIComponent(encoded);
    } catch {
      try {
        path = decodeURI(encoded);
      } catch {
        path = encoded;
      }
    }
  } else {
    if (!looksLikeLocalPath(pathPart)) return null;
    path = pathPart;
  }

  const line = Number(m[2]);
  const endRaw = m[3] ? Number(m[3]) : undefined;
  return {
    path,
    line: Number.isFinite(line) && line > 0 ? line : undefined,
    endLine: endRaw !== undefined && Number.isFinite(endRaw) && endRaw > 0 ? endRaw : undefined,
  };
}

export function findCodexCitations(text: string): CodexCitation[] {
  const out: CodexCitation[] = [];
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(text)) !== null) {
    const parsed = citationFromMatch(m);
    if (!parsed) continue;
    out.push({
      ...parsed,
      raw: m[0]!,
      start: m.index,
      end: m.index + m[0]!.length,
    });
  }
  return out;
}

export function citationLabel(path: string, line?: number, endLine?: number): string {
  const base = path.split(/[/\\]/).pop() || path;
  if (line === undefined) return base;
  if (endLine !== undefined && endLine !== line) return `${base}:${line}-${endLine}`;
  return `${base}:${line}`;
}
