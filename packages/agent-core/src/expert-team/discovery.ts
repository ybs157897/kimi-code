import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseManifest } from '../plugin/manifest';
import { normalizePluginId, type EnabledPluginExpert } from '../plugin/types';

/** Directory name scanned for drop-in expert team packages under each root. */
export const EXPERT_TEAMS_DIR_NAME = 'experts';

export interface DirectoryExpertIssue {
  readonly dir: string;
  readonly message: string;
}

export interface DirectoryExpertDiscovery {
  readonly experts: readonly EnabledPluginExpert[];
  readonly issues: readonly DirectoryExpertIssue[];
}

/**
 * Discovers drop-in expert team packages: each subdirectory of a root is a
 * package in the same layout as an expert plugin (a `kimi.plugin.json`
 * manifest with `expertType` plus agent .md files), usable without a plugin
 * install step. Roots are scanned in order and earlier roots win id
 * collisions, so callers pass project roots before user-level roots.
 */
export async function discoverDirectoryExperts(
  roots: readonly string[],
): Promise<DirectoryExpertDiscovery> {
  const experts = new Map<string, EnabledPluginExpert>();
  const issues: DirectoryExpertIssue[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));
    } catch {
      continue; // A missing root just means no teams are configured there.
    }
    for (const name of names) {
      const dir = path.join(root, name);
      if (!(await isDirectory(dir))) continue;
      const expert = await readDirectoryExpert(dir, issues);
      if (expert === undefined || experts.has(expert.pluginId)) continue;
      experts.set(expert.pluginId, expert);
    }
  }
  return { experts: [...experts.values()], issues };
}

async function readDirectoryExpert(
  dir: string,
  issues: DirectoryExpertIssue[],
): Promise<EnabledPluginExpert | undefined> {
  const parsed = await parseManifest(dir);
  const error = parsed.diagnostics.find((d) => d.severity === 'error');
  if (parsed.manifest === undefined) {
    // A directory without any manifest is not a package; only broken
    // manifests are worth surfacing.
    if (parsed.manifestPath !== undefined && error !== undefined) {
      issues.push({ dir, message: error.message });
    }
    return undefined;
  }
  if (parsed.manifest.expert === undefined) {
    issues.push({
      dir,
      message: error?.message ?? 'manifest does not declare "expertType"',
    });
    return undefined;
  }
  if (error !== undefined) {
    issues.push({ dir, message: error.message });
    return undefined;
  }
  return {
    ...parsed.manifest.expert,
    pluginId: normalizePluginId(parsed.manifest.name),
    pluginRoot: dir,
    pluginVersion: parsed.manifest.version,
    displayName: parsed.manifest.interface?.displayName ?? parsed.manifest.name,
    description:
      parsed.manifest.interface?.shortDescription ?? parsed.manifest.description,
  };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
