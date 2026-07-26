import { describe, expect, it } from 'vitest';
import { highlightSourceLines, resolveShikiLang } from '../src/lib/filePreviewHighlight';

describe('resolveShikiLang', () => {
  it('aliases daemon language ids and extensions to Shiki langs', () => {
    expect(resolveShikiLang('typescriptreact')).toBe('tsx');
    expect(resolveShikiLang('javascriptreact')).toBe('jsx');
    expect(resolveShikiLang('ts')).toBe('typescript');
    expect(resolveShikiLang('shellscript')).toBe('shellscript');
    expect(resolveShikiLang('TypeScript')).toBe('typescript');
  });
});

describe('highlightSourceLines', () => {
  it('highlights TypeScript into colored spans', async () => {
    const lines = await highlightSourceLines(
      'const x: number = 1;\n// comment\n',
      'typescript',
      'github-light',
    );
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(3);
    expect(lines![0]).toContain('style="color:');
    expect(lines![0]).toContain('const');
    expect(lines![1]).toContain('comment');
  }, 15_000);

  it('returns null for unknown languages', async () => {
    const lines = await highlightSourceLines('hello', 'not-a-real-lang-xyz', 'github-dark');
    expect(lines).toBeNull();
  }, 15_000);
});
