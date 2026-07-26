#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const upstreamPath = path.join(repoRoot, 'apps/kimi-code/CHANGELOG.md');
const docsPath = path.join(repoRoot, 'docs/en/release-notes/changelog.md');
const checkOnly = process.argv.includes('--check');

const upstream = await readFile(upstreamPath, 'utf8');
const currentDocs = await readFile(docsPath, 'utf8');
const documentedVersions = new Set(versionHeadings(currentDocs));
const missingReleases = parseReleases(upstream).filter(
  (release) => !documentedVersions.has(release.version),
);

if (missingReleases.length === 0) {
  process.stdout.write('Docs changelog is already up to date.\n');
  process.exit(0);
}

const generated = missingReleases.map(renderRelease).join('\n\n');
const nextDocs = insertBeforeFirstRelease(currentDocs, generated);

if (checkOnly) {
  process.stderr.write(
    `Docs changelog is missing: ${missingReleases.map((release) => release.version).join(', ')}\n`,
  );
  process.exit(1);
}

await writeFile(docsPath, nextDocs);
process.stdout.write(
  `Synced ${missingReleases.length} release${missingReleases.length === 1 ? '' : 's'} to ${path.relative(repoRoot, docsPath)}.\n`,
);

function versionHeadings(markdown) {
  return [...markdown.matchAll(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/gmu)].map(
    (match) => match[1],
  );
}

function parseReleases(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const releases = [];
  let current;
  let changesetSection;
  let entry;

  const finishEntry = () => {
    if (current === undefined || changesetSection === undefined || entry === undefined) return;
    const normalized = normalizeEntry(entry);
    if (normalized !== undefined) {
      current.entries.push({
        category: classifyEntry(normalized, changesetSection),
        text: normalized,
      });
    }
    entry = undefined;
  };

  const finishRelease = () => {
    finishEntry();
    if (current !== undefined && current.entries.length > 0) releases.push(current);
    current = undefined;
    changesetSection = undefined;
  };

  for (const line of lines) {
    const version = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(line)?.[1];
    if (version !== undefined) {
      finishRelease();
      current = { version, entries: [] };
      continue;
    }
    if (current === undefined) continue;

    const section = /^### (Major|Minor|Patch) Changes$/u.exec(line)?.[1];
    if (section !== undefined) {
      finishEntry();
      changesetSection = section;
      continue;
    }
    if (line.startsWith('### ')) {
      finishEntry();
      changesetSection = undefined;
      continue;
    }
    if (changesetSection === undefined) continue;

    if (line.startsWith('- ')) {
      finishEntry();
      entry = [line];
    } else if (entry !== undefined) {
      entry.push(line);
    }
  }
  finishRelease();
  return releases;
}

function normalizeEntry(lines) {
  const trimmed = [...lines];
  while (trimmed.at(-1)?.trim() === '') trimmed.pop();
  if (trimmed.length === 0) return undefined;

  let first = trimmed[0].trim();
  const creditMarker = first.lastIndexOf('! - ');
  if (creditMarker !== -1) {
    first = `- ${first.slice(creditMarker + 4).trim()}`;
  } else {
    first = first
      .replace(/^- \[#[^\]]+\]\([^)]+\)\s*/u, '- ')
      .replace(/\[`[^`]+`\]\([^)]+\)\s*/u, '');
  }
  trimmed[0] = first;

  const text = trimmed.join('\n').trim();
  if (/(?:^|\n)\s*-\s+Updated dependencies(?:\s|:)/u.test(text)) {
    return undefined;
  }
  return text.replace(/^-\s+/u, '');
}

function classifyEntry(text, changesetSection) {
  const sentence = text.replaceAll(/\s+/gu, ' ').trim();
  if (/^(Fix|Prevent|Restore|Correct|Avoid|Stop|Handle)\b/iu.test(sentence)) {
    return 'Bug Fixes';
  }
  if (/^(Add|Allow|Enable|Expose|Introduce|Support)\b/iu.test(sentence)) {
    return 'Features';
  }
  if (/^(Refactor|Rework|Unify)\b/iu.test(sentence)) {
    return 'Refactors';
  }
  if (changesetSection === 'Major' || changesetSection === 'Minor') {
    return 'Features';
  }
  return 'Polish';
}

function renderRelease(release) {
  const date = releaseDate(release.version);
  const heading = `## ${release.version}${date === undefined ? '' : ` (${date})`}`;
  const categories = ['Features', 'Bug Fixes', 'Polish', 'Refactors'];
  const sections = categories.flatMap((category) => {
    const entries = release.entries.filter((entry) => entry.category === category);
    if (entries.length === 0) return [];
    return [`### ${category}\n\n${entries.map((entry) => `- ${entry.text}`).join('\n')}`];
  });
  return [heading, ...sections].join('\n\n');
}

function releaseDate(version) {
  try {
    const output = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', `-S## ${version}`, '--', path.relative(repoRoot, upstreamPath)],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/u.test(output) ? output : undefined;
  } catch {
    return undefined;
  }
}

function insertBeforeFirstRelease(markdown, generated) {
  const match = /^## \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s|$)/mu.exec(markdown);
  if (match?.index === undefined) {
    return `${markdown.trimEnd()}\n\n${generated}\n`;
  }
  const before = markdown.slice(0, match.index).trimEnd();
  const after = markdown.slice(match.index).trimStart();
  return `${before}\n\n${generated}\n\n${after}`;
}
