export interface FilePathLink {
  path: string;
  line?: number;
  endLine?: number;
}

export interface FilePathLinkMatch extends FilePathLink {
  start: number;
  end: number;
  text: string;
}

export interface FindFilePathLinksOptions {
  aliases?: ReadonlyMap<string, string>;
}

const COMMON_FILE_EXTENSIONS = [
  'cjs',
  'css',
  'csv',
  'gif',
  'htm',
  'html',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'mjs',
  'pdf',
  'png',
  'scss',
  'svg',
  'ts',
  'tsx',
  'txt',
  'vue',
  'webp',
  'xml',
  'yaml',
  'yml',
];

const COMMON_FILENAMES = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
]);

const EXT_PATTERN = [...COMMON_FILE_EXTENSIONS]
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Line/col suffix: :12, :12-40, :12:4, :12:4-40:8, #L12, #L12C4, #L12-L40, #L12C4-L40C8 */
const LINE_SUFFIX =
  String.raw`(?:` +
  String.raw`#L?(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?` +
  String.raw`|` +
  String.raw`:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?` +
  String.raw`)?`;

const PATH_RE = new RegExp(
  [
    String.raw`(?:^|[\s([{"'` + '`' + String.raw`])`,
    String.raw`(`,
    // file:// URLs (pathname kept inside the same capture as the scheme)
    String.raw`file://(?:localhost)?/[^\s)"'\]]+`,
    String.raw`|`,
    String.raw`(?:~|\.{1,2}|/)?(?:[A-Za-z0-9_.@+()[\]-]+/)+[A-Za-z0-9_.@+()[\]-]+(?:\.(?:${EXT_PATTERN}))?`,
    String.raw`|`,
    String.raw`[A-Za-z0-9_.@+()[\]-]+\.(?:${EXT_PATTERN})`,
    String.raw`)`,
    LINE_SUFFIX,
    String.raw`(?=$|[\s)"'\]}>.,;!?，。；！？）])`,
  ].join(''),
  'gi',
);

const TRAILING_PUNCTUATION_RE = /[),.;!?，。；！？）]+$/;

function hasCommonFileExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return COMMON_FILE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

function normalizeFileUrl(path: string): string {
  if (!/^file:/i.test(path)) return path;
  try {
    const u = new URL(path);
    // file:///abs or file://localhost/abs
    return decodeURIComponent(u.pathname);
  } catch {
    return path.replace(/^file:\/\/(localhost)?/i, '');
  }
}

export function collectFilePathAliases(text: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const attrPathRe = new RegExp(
    String.raw`\b(?:path|src)=["'](\/[^"']+\.(?:${EXT_PATTERN}))["']`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = attrPathRe.exec(text)) !== null) {
    const absolutePath = match[1];
    if (!absolutePath) continue;
    const basename = absolutePath.split('/').pop();
    if (basename) aliases.set(basename, absolutePath);
  }
  return aliases;
}

interface LineRange {
  line?: number;
  endLine?: number;
}

function parseLineSuffix(groups: {
  hashLine?: string;
  hashCol?: string;
  hashEndLine?: string;
  hashEndCol?: string;
  colonLine?: string;
  colonCol?: string;
  colonEndLine?: string;
  colonEndCol?: string;
}): LineRange {
  const lineRaw = groups.hashLine ?? groups.colonLine;
  const endRaw = groups.hashEndLine ?? groups.colonEndLine;
  const line = lineRaw ? Number(lineRaw) : undefined;
  const endLine = endRaw ? Number(endRaw) : undefined;
  return {
    line: line !== undefined && Number.isFinite(line) && line > 0 ? line : undefined,
    endLine: endLine !== undefined && Number.isFinite(endLine) && endLine > 0 ? endLine : undefined,
  };
}

export function parseFilePathLinkCandidate(
  text: string,
  options: FindFilePathLinksOptions = {},
): FilePathLink | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:|tel:|data:|blob:)/i.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^file:/i.test(trimmed)) return null;

  const suffixRe = new RegExp(
    String.raw`^(.*?)(?:` +
      String.raw`#L?(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?` +
      String.raw`|` +
      String.raw`:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?` +
      String.raw`)?$`,
    'i',
  );
  const match = trimmed.match(suffixRe);
  if (!match) return null;

  let path = (match[1] ?? '').replace(TRAILING_PUNCTUATION_RE, '');
  if (!path) return null;
  path = normalizeFileUrl(path);

  const basename = path.split('/').pop() ?? path;
  const hasSeparator = path.includes('/');
  const hasKnownName = COMMON_FILENAMES.has(basename);
  const hasKnownExtension = hasCommonFileExtension(basename);
  if (hasSeparator && !hasKnownName && !hasKnownExtension) return null;
  if (!hasSeparator && !hasKnownName) {
    const alias = options.aliases?.get(basename);
    if (!alias) return null;
    path = alias;
  }

  const range = parseLineSuffix({
    hashLine: match[2],
    hashCol: match[3],
    hashEndLine: match[4],
    hashEndCol: match[5],
    colonLine: match[6],
    colonCol: match[7],
    colonEndLine: match[8],
    colonEndCol: match[9],
  });

  return {
    path,
    line: range.line,
    endLine: range.endLine,
  };
}

export function findFilePathLinks(
  text: string,
  options: FindFilePathLinksOptions = {},
): FilePathLinkMatch[] {
  const out: FilePathLinkMatch[] = [];
  PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_RE.exec(text)) !== null) {
    const full = match[0] ?? '';
    // Groups: 1=path (or file url path via alt), file url is inside group 1's alternatives
    // Rebuild matched path+suffix from the regex carefully.
    const rawPath = match[1] ?? '';
    const prefixLength = full.indexOf(rawPath);
    if (prefixLength < 0) continue;

    // Suffix groups follow the path group. With file:// alternative the group
    // indices shift — use the full match slice after path for suffix text.
    let linkText = full.slice(prefixLength);
    const stripped = linkText.replace(TRAILING_PUNCTUATION_RE, '');
    const trailing = linkText.length - stripped.length;
    linkText = stripped;

    const parsed = parseFilePathLinkCandidate(linkText, options);
    if (!parsed) continue;

    const start = match.index + prefixLength;
    const end = start + linkText.length;
    out.push({
      ...parsed,
      start,
      end,
      text: linkText,
    });

    if (trailing > 0) PATH_RE.lastIndex -= trailing;
  }
  return out;
}
