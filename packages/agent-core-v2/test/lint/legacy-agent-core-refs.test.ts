// @ts-nocheck — .mjs imports from repo root; no declaration for cross-package .mjs
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PKG_NAME,
  ALLOWLIST,
  extractSpecifiers,
  resolvesIntoLegacy,
  isAllowlisted,
  stripComments,
  scanDir,
  audit,
} from '../../../../scripts/check-legacy-agent-core-refs.mjs';

// ── Helpers ─────────────────────────────────────────────────────────────────

const V1 = ['@moonshot-ai', 'agent-core'].join('/');
const V1_EXT = `${V1}/extension`;

/** @type {string} */
let tmpRoot;
let counter = 0;

/** @param {string} name */
function fixture(name) {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = mkdtempSync(join(tmpdir(), `legacy-audit-fixture-${counter++}-`));
  return tmpRoot;
}

/** @param {string} rel @param {string} content */
function write(rel, content) {
  const full = join(tmpRoot, rel);
  mkdirSync(full.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function run() {
  const legacyRoot = join(tmpRoot, 'packages', 'agent-core');
  // Create an empty legacy package dir so relative resolution works
  mkdirSync(join(legacyRoot, 'src', 'config'), { recursive: true });
  mkdirSync(join(legacyRoot, 'src', 'session'), { recursive: true });
  mkdirSync(join(legacyRoot, 'src', 'tools', 'background'), { recursive: true });
  return scanDir(tmpRoot, legacyRoot);
}

/**
 * Helper: get violations (non-allowlisted, non-informational) from raw refs.
 * @param {import('../../../../scripts/check-legacy-agent-core-refs.mjs').Ref[]} refs
 */
function violations(refs) {
  return refs.filter((r) => {
    if (isAllowlisted(r.file, r.matched)) return false;
    if (r.category === 'lockfile' || r.category === 'nix') return false;
    return true;
  });
}

// ── Unit tests ─────────────────────────────────────────────────────────────

describe('extractSpecifiers', () => {
  it('finds static imports', () => {
    const s = extractSpecifiers(`import { x } from '${V1}';`);
    expect(s).toContain(V1);
  });

  it('finds subpath imports', () => {
    const s = extractSpecifiers(`import { y } from '${V1}/session';`);
    expect(s).toContain(`${V1}/session`);
  });

  it('finds export … from re-exports', () => {
    const s = extractSpecifiers(`export { z } from '${V1}';`);
    expect(s).toContain(V1);
  });

  it('finds export type … from', () => {
    const s = extractSpecifiers(`export type { T } from '${V1}';`);
    expect(s).toContain(V1);
  });

  it('finds import type', () => {
    const s = extractSpecifiers(`import type { T } from '${V1}';`);
    expect(s).toContain(V1);
  });

  it('finds dynamic import()', () => {
    const s = extractSpecifiers(`const m = await import('${V1}');`);
    expect(s).toContain(V1);
  });

  it('finds require()', () => {
    const s = extractSpecifiers(`const m = require('${V1}');`);
    expect(s).toContain(V1);
  });
});

describe('resolvesIntoLegacy', () => {
  it('catches direct relative import', () => {
    const from = join(tmpdir(), 'packages', 'node-sdk', 'test');
    const legacy = join(tmpdir(), 'packages', 'agent-core');
    expect(resolvesIntoLegacy('../../agent-core/src/config', from, legacy)).toBe(true);
  });

  it('catches deeply nested relative import with packages/ prefix', () => {
    const from = join(tmpdir(), 'apps', 'kimi-code', 'test', 'e2e');
    const legacy = join(tmpdir(), 'packages', 'agent-core');
    expect(resolvesIntoLegacy('../../../../packages/agent-core/src/logging/logger', from, legacy)).toBe(true);
  });

  it('does not match unrelated relative path', () => {
    const from = join(tmpdir(), 'packages', 'node-sdk', 'src');
    const legacy = join(tmpdir(), 'packages', 'agent-core');
    expect(resolvesIntoLegacy('../../kaos/src/foo', from, legacy)).toBe(false);
  });
});

describe('isAllowlisted', () => {
  it('matches a precise allowlist entry', () => {
    const entry = ALLOWLIST[0];
    expect(isAllowlisted(entry.file, entry.match)).toBeTruthy();
  });

  it('does not match a different file', () => {
    const entry = ALLOWLIST[0];
    expect(isAllowlisted('some/other/file.ts', entry.match)).toBeNull();
  });

  it('does not match a different specifier', () => {
    const entry = ALLOWLIST[0];
    expect(isAllowlisted(entry.file, `${V1}/something-else`)).toBeNull();
  });
});

describe('stripComments', () => {
  it('removes // line comments', () => {
    const raw = `// import from '${V1}'\nimport { x } from 'kaos';`;
    const clean = stripComments(raw, true);
    expect(clean).not.toContain(V1);
  });

  it('removes /* block comments */', () => {
    const raw = `/* import from '${V1}' */\nimport { x } from 'kaos';`;
    const clean = stripComments(raw, true);
    expect(clean).not.toContain(V1);
  });

  it('leaves import specifiers intact', () => {
    const raw = `import { x } from '${V1}';`;
    const clean = stripComments(raw, true);
    expect(clean).toContain(V1);
  });
});

// ── Fixture integration tests ───────────────────────────────────────────────

describe('scanDir — forbidden references', () => {
  it('flags a production import of the legacy package', () => {
    fixture('prod-import');
    write('packages/demo/src/index.ts', `import { KimiCore } from '${V1}';`);
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('production');
  });

  it('flags a test-only import of the legacy package', () => {
    fixture('test-import');
    write('packages/demo/test/demo.test.ts', `import { KimiCore } from '${V1}';`);
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('test-only');
  });

  it('flags a subpath import', () => {
    fixture('subpath-import');
    write('packages/demo/src/index.ts', `import { x } from '${V1}/session';`);
    const refs = run();
    expect(violations(refs)).toHaveLength(1);
  });

  it('flags a relative import into packages/agent-core/src', () => {
    fixture('rel-import');
    write('packages/demo/test/foo.test.ts', `import { x } from '../../agent-core/src/config';`);
    const refs = run();
    expect(violations(refs)).toHaveLength(1);
  });

  it('does not flag @moonshot-ai/agent-core-v2', () => {
    fixture('v2-only');
    write('packages/demo/src/index.ts', `import { x } from '${V1}-v2';`);
    const refs = run();
    expect(violations(refs)).toHaveLength(0);
  });

  it('does not flag a comment mentioning the legacy package', () => {
    fixture('comment-only');
    write('packages/demo/src/index.ts', `// This was imported from '${V1}'`);
    const refs = run();
    expect(violations(refs)).toHaveLength(0);
  });
});

describe('scanDir — extension virtual specifier allowlist', () => {
  it('allowlists the virtual specifier in the designated file', () => {
    fixture('ext-allowlist');
    write(
      'packages/agent-core-v2/src/app/extension/extensionLoaderService.ts',
      `const map = { '${V1_EXT}': hostApi };`,
    );
    const refs = run();
    // found, but allowlisted → no violation
    const found = refs.filter((r) => r.matched?.includes('extension'));
    expect(found.length).toBeGreaterThan(0);
    expect(violations(refs)).toHaveLength(0);
  });

  it('flags the virtual specifier in a non-allowlisted file', () => {
    fixture('ext-flagged');
    write(
      'packages/other/src/loader.ts',
      `const map = { '${V1_EXT}': hostApi };`,
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('production');
  });
});

describe('scanDir — manifest and config detection', () => {
  it('flags a package.json dependency', () => {
    fixture('pkg-dep');
    write(
      'packages/demo/package.json',
      JSON.stringify({ name: 'demo', dependencies: { [V1]: 'workspace:^' } }),
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('manifest');
  });

  it('flags a package.json build filter script', () => {
    fixture('pkg-filter');
    write(
      'packages/demo/package.json',
      JSON.stringify({ name: 'demo', scripts: { 'build:deps': `pnpm --filter ${V1}... build` } }),
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('manifest');
  });

  it('flags a tsdown.config.ts alias', () => {
    fixture('tsdown-alias');
    write(
      'packages/demo/tsdown.config.ts',
      `export default { alias: { '${V1}': resolve(__dirname, '../agent-core/src/index.ts') } };`,
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('config');
  });

  it('flags a tsconfig.json include referencing agent-core', () => {
    fixture('tsconfig-include');
    write(
      'packages/demo/tsconfig.json',
      JSON.stringify({ include: ['src', '../../packages/agent-core/src/prompt-modules.d.ts'] }),
    );
    const refs = run();
    const v = violations(refs);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.some((r) => r.category === 'config')).toBe(true);
  });

  it('flags an api-extractor.json bundledPackage', () => {
    fixture('api-extractor');
    write(
      'packages/demo/api-extractor.json',
      JSON.stringify({ bundledPackages: [V1] }),
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('config');
  });

  it('flags a watch script source directory entry', () => {
    fixture('watch-script');
    write(
      'apps/vscode/scripts/watch-extension.mjs',
      `const dirs = ['agent-core', 'kaos'];`,
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('config');
  });

  it('flags a build-dts.mjs package-dir entry', () => {
    fixture('build-dts');
    write(
      'packages/node-sdk/scripts/build-dts.mjs',
      `const dirs = new Set(['agent-core', 'kaos']);`,
    );
    const refs = run();
    const v = violations(refs);
    expect(v).toHaveLength(1);
    expect(v[0]?.category).toBe('config');
  });
});

describe('scanDir — nix and informational', () => {
  it('detects flake.nix double-quoted name and bare path', () => {
    fixture('flake-nix');
    write(
      'flake.nix',
      `workspacePaths = [ ./packages/agent-core ];\nworkspaceNames = [ "${V1}" ];`,
    );
    const refs = run();
    const nix = refs.filter((r) => r.file === 'flake.nix');
    // double-quoted token + bare path
    expect(nix.length).toBeGreaterThanOrEqual(2);
    for (const r of nix) {
      expect(r.category).toBe('nix');
    }
    // nix refs are informational, not violations
    expect(violations(refs)).toHaveLength(0);
  });
});

// ── End-to-end audit() test ─────────────────────────────────────────────────

describe('audit()', () => {
  it('returns structured counts', () => {
    fixture('audit-e2e');
    write('packages/demo/src/index.ts', `import { x } from '${V1}';`);
    write('packages/demo/test/demo.test.ts', `import { y } from '${V1}';`);
    const report = audit(tmpRoot);
    expect(report.counts.violations).toBe(2);
    expect(report.counts.production).toBe(1);
    expect(report.counts.testOnly).toBe(1);
  });
});
