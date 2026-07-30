#!/usr/bin/env node
/**
 * Executable legacy reference auditor for `@moonshot-ai/agent-core`.
 *
 * Scans the repository (apps, packages, scripts, root-level config files) for
 * executable references to the legacy package, covering:
 *   - static & dynamic import/export/require specifiers (source + test)
 *   - package.json dependencies / devDependencies / peerDependencies
 *   - package.json script filters (e.g. `--filter @moonshot-ai/agent-core`)
 *   - tsdown / vitest config aliases and externals
 *   - tsconfig.json include / paths
 *   - API Extractor bundledPackages
 *   - scripts/*.mjs / *.config.ts string literals
 *   - pnpm-lock.yaml importer dep keys & link edges (informational)
 *   - flake.nix workspace entries (informational)
 *
 * Classification per reference:
 *   production  | test-only  | config  | manifest  | lockfile  | nix
 *
 * Gate semantics:
 *   violations  = production + test-only + config + manifest (non-allowlist)
 *   informational = lockfile + nix (removed atomically by CLEAN-702)
 *
 * Exit code 0 when violations = 0, 1 otherwise.
 *
 * Allowlist entries are precise (file + match substring + reason).
 * No wildcard / directory-level exemptions.
 *
 * Usage:
 *   node scripts/check-legacy-agent-core-refs.mjs [--root DIR] [--json]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Configuration ──────────────────────────────────────────────────────────

const PKG_NAME = ['@moonshot-ai', 'agent-core'].join('/');
const LEGACY_DIR = ['packages', 'agent-core'].join('/');

const ALLOWLIST = [
  {
    file: 'packages/agent-core-v2/src/app/extension/extensionLoaderService.ts',
    match: '@moonshot-ai/agent-core/extension',
    reason: 'Extension virtual specifier retained for existing user extensions; maps to the v2 host API (migration plan §2.2).',
  },
  {
    file: 'packages/agent-core-v2/scripts/check-domain-layers.mjs',
    match: '@moonshot-ai/agent-core',
    reason: 'Forbidden-pattern literal of the v2 v1-import ban lint; not a dependency.',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const SELF = resolve(fileURLToPath(import.meta.url));

/** Files whose basename or path qualifies them for extra literal-pass scanning. */
function isConfigLike(rel) {
  const base = rel.split('/').pop();
  if (base === 'api-extractor.json') return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/\.config\.(ts|mts|js|mjs|cts|cjs)$/.test(base)) return true;
  if (base.endsWith('.nix')) return true;
  if (/\/scripts\//.test(rel)) return true;
  if (base.endsWith('.json') && base !== 'package.json') return true;
  return false;
}

/** True when the file path places it under a test area. */
function isTestPath(rel) {
  return /\/test\/|\.(test|spec|e2e|bench|integration)\./.test(rel);
}

/** Skip dot-directory ancestors (e.g. .git, .kimi-code, .changeset). */
function hasDotDir(rel) {
  return rel.split('/').some((seg) => seg.startsWith('.'));
}

/**
 * Strip // and /* comments from JS/TS source so that import specifiers inside
 * comment blocks are not treated as real references.
 */
function stripComments(raw, isSource) {
  if (!isSource) return raw;
  // Remove /** ... */ block comments
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove // line comments (but not URLs inside strings — approximate)
  raw = raw.replace(/\/\/.*$/gm, '');
  return raw;
}

/**
 * Import/export/require/dynamic-import specifier extractor.
 * Returns array of extracted quoted specifier strings.
 */
const SPECIFIER_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function extractSpecifiers(source) {
  const out = [];
  let m;
  while ((m = SPECIFIER_RE.exec(source)) !== null) {
    const spec = m[1] || m[2];
    if (spec) out.push(spec);
  }
  return out;
}

/** Extract single- and double-quoted string literal contents. */
const QUOTED_RE = /['"]([^'"]*)['"]/g;

/** Check whether a relative specifier resolves inside `packages/agent-core/`. */
function resolvesIntoLegacy(spec, fromDir, legacyRoot) {
  if (spec.startsWith('../') || spec.startsWith('./')) {
    const resolved = resolve(fromDir, spec);
    return resolved.startsWith(legacyRoot + '/') || resolved === legacyRoot;
  }
  return false;
}

/** Match a reference against the allowlist. */
function isAllowlisted(relFile, matchedText) {
  for (const entry of ALLOWLIST) {
    if (relFile === entry.file && (matchedText || '').includes(entry.match)) {
      return entry;
    }
  }
  return null;
}

/** Count newlines up to a given character index. */
function lineOf(raw, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < raw.length; i++) if (raw[i] === '\n') n++;
  return n;
}

// ── Core scanner ────────────────────────────────────────────────────────────

/**
 * @typedef {{ file: string, line: number, matched: string, kind: string, category: string, allowlist?: { reason: string } }} Reference
 */

/**
 * Walk a directory tree and return all legacy package references.
 * @param {string} root - repo root
 * @param {string} legacyRoot - absolute path to `packages/agent-core`
 * @returns {Reference[]}
 */
function scanDir(root, legacyRoot) {
  /** @type {Reference[]} */
  const refs = [];

  const sourceExts = new Set([
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  ]);

  function addRef(relFile, line, matched, kind, category) {
    // dedup by file:line
    const key = `${relFile}:${line}`;
    if (refs.some(r => `${r.file}:${r.line}` === key)) return;
    refs.push({ file: relFile, line, matched, kind, category });
  }

  function scan(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.tmp') continue;
        if (rel === 'tmp' || rel === 'docs' || rel.startsWith('docs/')) continue;
        if (full.startsWith(legacyRoot + '/') || full === legacyRoot) continue;
        scan(full);
      } else if (e.isFile()) {
        if (hasDotDir(rel)) continue;
        if (full === SELF) continue;
        const ext = e.name.split('.').pop();
        const isSrc = sourceExts.has(ext);
        const isConf = isConfigLike(rel);
        const isPkgJson = e.name === 'package.json';
        if (!isSrc && !isConf && !isPkgJson) continue;

        let raw;
        try {
          raw = readFileSync(full, 'utf8');
        } catch {
          continue;
        }

        // ── structured package.json scan
        if (isPkgJson) {
          scanPackageJson(rel, raw);
          continue;
        }

        const clean = stripComments(raw, isSrc);

        // ── Pass 1: specifier scan. Line numbers computed on the
        // comment-stripped text so they align with the literal pass
        // (shared dedup key = file:cleanLine).
        for (const spec of extractSpecifiers(clean)) {
          if (!spec.startsWith('@moonshot-ai/') && !spec.startsWith('.') && !spec.startsWith('/')) continue;
          const isMatch =
            (spec === PKG_NAME || spec.startsWith(PKG_NAME + '/')) ||
            resolvesIntoLegacy(spec, dir, legacyRoot);
          if (!isMatch) continue;
          const line = lineOf(clean, clean.indexOf(spec));

          let cat = 'production';
          if (isConf && e.name === 'flake.nix') cat = 'nix';
          else if (isTestPath(rel)) cat = 'test-only';

          addRef(rel, line, spec, 'import', cat);
        }

        // ── Pass 2: literal scan (on comment-stripped text to avoid
        // flagging quoted tokens that only appear inside comments).
        // Source files: narrow match (exact token + subpaths) for virtual
        // specifiers like the extension loader. Config files: also match
        // bare 'agent-core' and path fragments.
        const runLiteral = isConf || isSrc;
        if (runLiteral) {
          const broad = isConf;

          // .nix files: single-quoted strings can be multi-line (''…''),
          // so scan double-quoted strings only + bare path tokens on
          // non-comment lines.
          if (e.name === 'flake.nix' || ext === 'nix') {
            // Double-quoted tokens
            for (const m of raw.matchAll(/"([^"]*)"/g)) {
              const val = m[1];
              if (!val) continue;
              const hit =
                val === PKG_NAME || val.startsWith(PKG_NAME + '/') ||
                val === 'agent-core' ||
                val.includes('packages/agent-core/') ||
                resolvesIntoLegacy(val, dir, legacyRoot);
              if (!hit) continue;
              addRef(rel, lineOf(raw, m.index), val, 'literal', 'nix');
            }
            // Bare (unquoted) Nix paths on non-comment lines
            const rawLines = raw.split('\n');
            for (let i = 0; i < rawLines.length; i++) {
              const l = rawLines[i];
              if (/^\s*#/.test(l)) continue;
              if (l.includes('packages/agent-core') && !l.includes('packages/agent-core-v2')) {
                addRef(rel, i + 1, './packages/agent-core', 'literal', 'nix');
              }
            }
          } else {
            for (const m of clean.matchAll(QUOTED_RE)) {
              const val = m[1];
              if (!val) continue;
              const isToken = val === PKG_NAME || val.startsWith(PKG_NAME + '/');
              const isBare = broad && val === 'agent-core';
              const isPathFrag = broad && val.includes('packages/agent-core/');
              const resolves = broad && resolvesIntoLegacy(val, dir, legacyRoot);
              if (!isToken && !isBare && !isPathFrag && !resolves) continue;

              // line-of in comment-stripped text (within a few lines of raw)
              const line = lineOf(clean, m.index);

              let cat = 'config';
              if (!isConf && isTestPath(rel)) cat = 'test-only';
              else if (!isConf) cat = 'production';

              addRef(rel, line, val, 'literal', cat);
            }
          }
        }
      }
    }
  }

  scan(root);

  // ── structured package.json subroutine
  function scanPackageJson(relFile, raw) {
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      return;
    }
    const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const field of depFields) {
      const deps = pkg[field];
      if (!deps || !deps[PKG_NAME]) continue;
      addRef(relFile, lineOf(raw, raw.indexOf(PKG_NAME)), PKG_NAME, 'dependency', 'manifest');
    }
    if (pkg.scripts) {
      for (const [, script] of Object.entries(pkg.scripts)) {
        if (typeof script !== 'string') continue;
        if (!script.includes(PKG_NAME)) continue;
        // show the part of the script containing the token
        const display = script.substring(
          Math.max(0, script.indexOf(PKG_NAME) - 20),
          Math.min(script.length, script.indexOf(PKG_NAME) + PKG_NAME.length + 20),
        );
        addRef(relFile, lineOf(raw, raw.indexOf(script)), display, 'build-filter', 'manifest');
      }
    }
  }

  return refs;
}

// ── Lockfile scan ───────────────────────────────────────────────────────────

/**
 * @param {string} lockPath
 * @returns {{ file: string, line: number, matched: string, kind: string, category: 'lockfile', importer: string }[]}
 */
function scanLockfile(lockPath) {
  /** @type {any[]} */
  const refs = [];
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return refs;
  }

  const lines = raw.split('\n');
  let currentImporter = '(root)';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^\s{2}([\w@][^:]+):$/);
    if (headerMatch) {
      currentImporter = headerMatch[1];
      continue;
    }
    if (/^[^\s]/.test(line)) {
      currentImporter = '(none)';
      continue;
    }
    const depMatch = line.match(/^\s{6}'(@moonshot-ai\/agent-core)':$/);
    if (depMatch) {
      refs.push({
        file: 'pnpm-lock.yaml',
        line: i + 1,
        matched: depMatch[1],
        kind: 'dep-key',
        category: 'lockfile',
        importer: currentImporter,
      });
      continue;
    }
    const linkMatch = line.match(/^\s{8}version:\s+(link:[^\s]*agent-core)$/);
    if (linkMatch) {
      refs.push({
        file: 'pnpm-lock.yaml',
        line: i + 1,
        matched: linkMatch[1].trim(),
        kind: 'link-edge',
        category: 'lockfile',
        importer: currentImporter,
      });
    }
  }
  return refs;
}

// ── Report / main ───────────────────────────────────────────────────────────

function audit(root) {
  const legacyRoot = join(root, LEGACY_DIR);
  const allRefs = scanDir(root, legacyRoot);

  // Lockfile
  const lockPath = join(root, 'pnpm-lock.yaml');
  allRefs.push(...scanLockfile(lockPath));

  const violations = [];
  const informational = [];
  const allowed = [];

  for (const r of allRefs) {
    const entry = isAllowlisted(r.file, r.matched);
    if (entry) {
      r.allowlist = entry;
      allowed.push(r);
    } else if (r.category === 'lockfile' || r.category === 'nix') {
      informational.push(r);
    } else {
      violations.push(r);
    }
  }

  const byFile = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
  violations.sort(byFile);
  informational.sort(byFile);
  allowed.sort(byFile);

  const counts = {
    violations: violations.length,
    production: violations.filter(r => r.category === 'production').length,
    testOnly: violations.filter(r => r.category === 'test-only').length,
    config: violations.filter(r => r.category === 'config').length,
    manifest: violations.filter(r => r.category === 'manifest').length,
    informational: informational.length,
    allowlist: allowed.length,
  };

  return { violations, informational, allowed, counts };
}

function printReport({ violations, informational, allowed, counts }) {
  const catPad = (cat) => `[${cat}]`.padEnd(14);

  console.log('Legacy agent-core reference audit');
  console.log('=================================\n');

  if (violations.length) {
    console.log('VIOLATIONS (must be zero before packages/agent-core deletion)');
    console.log('-'.repeat(70));
    for (const r of violations) {
      console.log(`  ${catPad(r.category)} ${r.file}:${r.line}\t${r.matched}`);
    }
    console.log();
  }

  if (informational.length) {
    console.log('INFORMATIONAL (removed atomically by the CLEAN-702 deletion commit)');
    console.log('-'.repeat(70));
    for (const r of informational) {
      console.log(`  ${catPad(r.category)} ${r.file}:${r.line}\t${r.matched}`);
    }
    console.log();
  }

  if (allowed.length) {
    console.log('ALLOWLISTED');
    console.log('-'.repeat(70));
    for (const r of allowed) {
      const reason = r.allowlist?.reason ?? '';
      console.log(`  ${r.file}:${r.line}  "${r.matched}"  — ${reason}`);
    }
    console.log();
  }

  console.log('Summary:');
  console.log(`  violations:  ${counts.violations}  (production ${counts.production}, test-only ${counts.testOnly}, config ${counts.config}, manifest ${counts.manifest})`);
  console.log(`  informational: ${counts.informational}`);
  console.log(`  allowlisted:   ${counts.allowlist}`);
  console.log(counts.violations ? '\nFAIL — non-allowlisted references found.' : '\nPASS — zero violation.');
}

// ── Exports for tests ───────────────────────────────────────────────────────

export {
  PKG_NAME,
  LEGACY_DIR,
  ALLOWLIST,
  extractSpecifiers,
  resolvesIntoLegacy,
  isAllowlisted,
  stripComments,
  scanDir,
  scanLockfile,
  audit,
};

// ── CLI entry (guarded so import doesn't trigger process.exit) ──────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  let root = resolve('.');
  let jsonOut = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      root = resolve(args[++i]);
    } else if (args[i] === '--json') {
      jsonOut = true;
    }
  }
  const report = audit(root);
  if (jsonOut) {
    process.stdout.write(JSON.stringify({
      violations: report.violations,
      informational: report.informational,
      allowlist: report.allowed,
      summary: report.counts,
    }, null, 2) + '\n');
  } else {
    printReport(report);
  }
  process.exit(report.counts.violations > 0 ? 1 : 0);
}
