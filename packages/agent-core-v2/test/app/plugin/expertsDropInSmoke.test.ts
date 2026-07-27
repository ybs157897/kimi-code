import { describe, expect, it } from 'vitest';

import { parseManifest } from '#/app/plugin/manifest';
import { sessionExpertRoots, discoverDirectoryExperts } from '#/app/plugin/directoryExperts';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
const expertsRoot = path.join(repoRoot, '.kimi-code', 'experts');
const packages = [
  'ai-data-copilot',
  'aicoding-architecture-expert-team',
  'openspec-doc-team',
  'senior-developer',
];

describe('drop-in expert packages', () => {
  for (const pkg of packages) {
    it(`${pkg}: parses with no errors`, async () => {
      const result = await parseManifest(path.join(expertsRoot, pkg));
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      expect(errors, errors.map((e) => e.message).join('\n')).toEqual([]);
      expect(result.manifest?.expert).toBeDefined();
      expect(result.manifest?.expert?.type).toMatch(/^(agent|team)$/);
      expect(result.manifest?.interface?.displayName).toBeTruthy();
    });
  }

  it('all 5 packages (incl. code-review-team) are discovered via discoverDirectoryExperts', async () => {
    const root = sessionExpertRoots(repoRoot, '/nonexistent').find((r) =>
      r.includes('.kimi-code'),
    )!;
    const discovery = await discoverDirectoryExperts([root]);
    expect(discovery.issues).toEqual([]);
    const ids = discovery.experts.map((e) => e.pluginId).sort();
    expect(ids).toEqual([
      'ai-data-copilot',
      'aicoding-architecture-expert-team',
      'code-review-team',
      'openspec-doc-team',
      'senior-developer',
    ]);
  });
});
