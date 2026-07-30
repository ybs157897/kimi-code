/**
 * `skillCatalog` domain (L3) — `IWorkspaceSkillCatalogService` implementation.
 *
 * Resolves builtin, plugin, extra, user or explicit, and project contributions
 * through `skillCatalog`, `plugin`, `config`, and `bootstrap`, then merges them
 * with Session-catalog priority semantics. Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';

import { IBuiltinSkillSource } from './builtinSkillSource';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type ExtraSkillDirsConfig,
  type MergeAllAvailableSkillsConfig,
} from './configSection';
import { InMemorySkillCatalog } from './registry';
import { ISkillCatalogRuntimeOptions } from './skillCatalogRuntimeOptions';
import { ISkillDiscovery } from './skillDiscovery';
import { configuredRoots, projectRoots, userRoots } from './skillRoots';
import { SKILL_SOURCE_PRIORITY, type SkillContribution } from './skillSource';
import { summarizeSkill, type SkillSummary } from './types';
import { IWorkspaceSkillCatalogService } from './workspaceSkillCatalog';

interface PrioritizedContribution {
  readonly contribution: SkillContribution;
  readonly priority: number;
}

const EMPTY_CONTRIBUTION: SkillContribution = { skills: [] };

export class WorkspaceSkillCatalogService implements IWorkspaceSkillCatalogService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBuiltinSkillSource private readonly builtin: IBuiltinSkillSource,
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IPluginService private readonly plugins: IPluginService,
    @IConfigService private readonly config: IConfigService,
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async list(workDir: string): Promise<readonly SkillSummary[]> {
    await this.config.ready;
    const explicitDirs = this.runtimeOptions.explicitDirs ?? [];
    const useExplicitDirs = explicitDirs.length > 0;
    const extraSkillDirs =
      this.config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(
        MERGE_ALL_AVAILABLE_SKILLS_SECTION,
      ) ?? true;
    const rootsOptions = { mergeAllAvailableSkills };

    const [
      builtin,
      plugin,
      extra,
      user,
      explicit,
      project,
    ] = await Promise.all([
      this.builtin.load(),
      this.discoverPluginSkills(),
      this.discoverConfigured(extraSkillDirs, workDir, 'extra'),
      useExplicitDirs
        ? Promise.resolve(EMPTY_CONTRIBUTION)
        : this.discoverUserSkills(rootsOptions),
      useExplicitDirs
        ? this.discoverConfigured(explicitDirs, workDir, 'user')
        : Promise.resolve(EMPTY_CONTRIBUTION),
      useExplicitDirs
        ? Promise.resolve(EMPTY_CONTRIBUTION)
        : this.discovery.discover(await projectRoots(workDir, rootsOptions)),
    ]);

    return mergeContributions([
      { contribution: builtin, priority: SKILL_SOURCE_PRIORITY.builtin },
      { contribution: plugin, priority: SKILL_SOURCE_PRIORITY.plugin },
      { contribution: extra, priority: SKILL_SOURCE_PRIORITY.extra },
      { contribution: user, priority: SKILL_SOURCE_PRIORITY.user },
      { contribution: explicit, priority: SKILL_SOURCE_PRIORITY.user },
      { contribution: project, priority: SKILL_SOURCE_PRIORITY.workspace },
    ]);
  }

  private async discoverPluginSkills(): Promise<SkillContribution> {
    return this.discovery.discover(await this.plugins.pluginSkillRoots());
  }

  private async discoverConfigured(
    dirs: readonly string[],
    workDir: string,
    source: 'extra' | 'user',
  ): Promise<SkillContribution> {
    return this.discovery.discover(
      await configuredRoots(dirs, workDir, this.bootstrap.osHomeDir, source),
    );
  }

  private async discoverUserSkills(
    options: { readonly mergeAllAvailableSkills: boolean },
  ): Promise<SkillContribution> {
    return this.discovery.discover(
      await userRoots(this.bootstrap.homeDir, this.bootstrap.osHomeDir, options),
    );
  }
}

function mergeContributions(
  contributions: readonly PrioritizedContribution[],
): readonly SkillSummary[] {
  const catalog = new InMemorySkillCatalog();
  for (const { contribution } of contributions.toSorted(
    (left, right) => left.priority - right.priority,
  )) {
    for (const skill of contribution.skills) {
      catalog.register(skill, { replace: true });
    }
  }
  return catalog.listSkills().map(summarizeSkill);
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceSkillCatalogService,
  WorkspaceSkillCatalogService,
  ScopeActivation.OnDemand,
  'skillCatalog',
);
