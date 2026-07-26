import { describe, expect, it } from 'vitest';
import {
  attrBool,
  citationLabel,
  classifyDirective,
  findCodexCitations,
  parseCodexCitationLiteral,
  parseDirectiveAttrs,
  parseDirectiveHeader,
  preprocessCodexMarkdown,
  segmentCodexMarkdown,
} from '../src/lib/codexMarkdown';
import { parseFilePathLinkCandidate } from '../src/lib/filePathLinks';

describe('parseDirectiveAttrs', () => {
  it('parses quoted strings, flags, numbers, and escapes', () => {
    expect(
      parseDirectiveAttrs('summary="he said \\"hi\\"" open path=/tmp/a.ts count=3'),
    ).toEqual({
      summary: 'he said "hi"',
      open: true,
      path: '/tmp/a.ts',
      count: 3,
    });
  });

  it('fail-softs on junk without throwing', () => {
    expect(() => parseDirectiveAttrs('@@@ path="x"')).not.toThrow();
    expect(parseDirectiveAttrs('path="x"')).toEqual({ path: 'x' });
  });
});

describe('parseDirectiveHeader / classify', () => {
  it('parses container and leaf headers', () => {
    expect(parseDirectiveHeader(':::github-details{summary="A" open="true"}')).toMatchObject({
      name: 'github-details',
      container: true,
    });
    expect(parseDirectiveHeader('::task-stub{title="T"}')).toMatchObject({
      name: 'task-stub',
      container: false,
    });
    expect(attrBool(parseDirectiveHeader(':::github-details{open="true"}')!.attrs, 'open')).toBe(
      true,
    );
  });

  it('classifies visible / hidden / unknown', () => {
    expect(classifyDirective('codex-file-citation')).toBe('visible');
    expect(classifyDirective('git-commit')).toBe('hidden');
    expect(classifyDirective('codex-live-vis')).toBe('hidden');
    expect(classifyDirective('nope')).toBe('unknown');
  });
});

describe('preprocessCodexMarkdown', () => {
  it('strips comments and converts details + alerts without touching fences', () => {
    const src = [
      '<!-- secret -->',
      '> [!NOTE]',
      '> Hello',
      '',
      '```ts',
      '// > [!WARNING]',
      'const x = 1;',
      '```',
      '',
      '<details open><summary>Sum</summary>',
      'Body **md**',
      '</details>',
    ].join('\n');

    const out = preprocessCodexMarkdown(src);
    expect(out).not.toContain('<!--');
    expect(out).toContain(':::github-alert{type="NOTE"}');
    expect(out).toContain('Hello');
    expect(out).toContain(':::github-details{summary="Sum" open="true"}');
    expect(out).toContain('```ts');
    expect(out).toContain('// > [!WARNING]');
  });
});

describe('segmentCodexMarkdown', () => {
  it('hides control directives and keeps unknown as raw', () => {
    const segs = segmentCodexMarkdown(
      [
        'Hi',
        '::git-commit{cwd="/repo" branch="main"}',
        '::unknown-thing{a=1}',
        '::codex-file-citation{path="src/a.ts" line_range_start=12 line_range_end=40}',
      ].join('\n'),
    );
    expect(segs.some((s) => s.kind === 'hidden')).toBe(true);
    expect(segs.some((s) => s.kind === 'raw' && s.text.includes('unknown-thing'))).toBe(true);
    expect(segs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'citation',
          path: 'src/a.ts',
          line: 12,
          endLine: 40,
        }),
      ]),
    );
  });

  it('parses details / alert / task-stub / writing containers', () => {
    const segs = segmentCodexMarkdown(
      [
        ':::github-details{summary="Title" open="true"}',
        'inside',
        ':::',
        ':::github-alert{type="WARNING"}',
        'careful',
        ':::',
        '::task-stub{title="Do it"}',
        'prompt body',
        '',
        ':::writing{title="Doc" variant="document"}',
        'write me',
        ':::',
      ].join('\n'),
    );
    expect(segs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'details', summary: 'Title', open: true, body: 'inside' }),
        expect.objectContaining({ kind: 'alert', type: 'WARNING', body: 'careful' }),
        expect.objectContaining({ kind: 'task-stub', title: 'Do it', body: 'prompt body' }),
        expect.objectContaining({ kind: 'writing', title: 'Doc', variant: 'document', body: 'write me' }),
      ]),
    );
  });

  it('keeps ```diff fences as diff segments', () => {
    const segs = segmentCodexMarkdown('before\n```diff\n-a\n+b\n```\nafter');
    expect(segs.find((s) => s.kind === 'diff')).toMatchObject({ code: '-a\n+b' });
  });
});

describe('citations', () => {
  it('parses 【†L】 literals including F: encoding', () => {
    expect(parseCodexCitationLiteral('【src/a.ts†L12】')).toEqual({
      path: 'src/a.ts',
      line: 12,
      endLine: undefined,
    });
    expect(parseCodexCitationLiteral('【src/a.ts†L12-L40】')).toMatchObject({
      path: 'src/a.ts',
      line: 12,
      endLine: 40,
    });
    expect(parseCodexCitationLiteral('【F:src%2Ffoo.ts†L3】')).toMatchObject({
      path: 'src/foo.ts',
      line: 3,
    });
    expect(citationLabel('src/a.ts', 12, 40)).toBe('a.ts:12-40');
  });

  it('finds citations in prose', () => {
    const hits = findCodexCitations('See 【pkg/x.ts†L1-L2】 and more');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'pkg/x.ts', line: 1, endLine: 2 });
  });
});

describe('file path ranges', () => {
  it('parses colon / hash ranges and file:// URLs', () => {
    expect(parseFilePathLinkCandidate('src/a.ts:12-40')).toMatchObject({
      path: 'src/a.ts',
      line: 12,
      endLine: 40,
    });
    expect(parseFilePathLinkCandidate('src/a.ts:12:4-40:8')).toMatchObject({
      path: 'src/a.ts',
      line: 12,
      endLine: 40,
    });
    expect(parseFilePathLinkCandidate('src/a.ts#L12C4-L40C8')).toMatchObject({
      path: 'src/a.ts',
      line: 12,
      endLine: 40,
    });
    expect(parseFilePathLinkCandidate('file:///Users/me/a.ts:10')).toMatchObject({
      path: '/Users/me/a.ts',
      line: 10,
    });
  });
});
