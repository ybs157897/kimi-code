import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import type { PluginCapabilityState, PluginGithubMetadata, PluginSource } from './types';

const INSTALLED_SCOPE = 'plugins';
const INSTALLED_KEY = 'installed.json';

export interface InstalledRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly github?: PluginGithubMetadata;
}

export interface InstalledFile {
  readonly version: 1;
  readonly plugins: readonly InstalledRecord[];
}

const EMPTY: InstalledFile = { version: 1, plugins: [] };

export async function readInstalled(store: IAtomicDocumentStore): Promise<InstalledFile> {
  const parsed = await store.get<InstalledFile>(INSTALLED_SCOPE, INSTALLED_KEY);
  if (parsed === undefined) return EMPTY;
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.plugins)) {
    throw new Error('installed.json is not a valid InstalledFile object');
  }
  return parsed;
}

export async function writeInstalled(
  store: IAtomicDocumentStore,
  data: InstalledFile,
): Promise<void> {
  await store.set(INSTALLED_SCOPE, INSTALLED_KEY, data);
}
