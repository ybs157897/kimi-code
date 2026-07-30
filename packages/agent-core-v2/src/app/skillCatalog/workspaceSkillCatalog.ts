/**
 * `skillCatalog` domain (L3) — session-less workspace skill listing contract.
 *
 * Defines the App-scoped read service that resolves the public skill summaries
 * available for a work directory without creating a Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SkillSummary } from './types';

export interface IWorkspaceSkillCatalogService {
  readonly _serviceBrand: undefined;

  list(workDir: string): Promise<readonly SkillSummary[]>;
}

export const IWorkspaceSkillCatalogService: ServiceIdentifier<IWorkspaceSkillCatalogService> =
  createDecorator<IWorkspaceSkillCatalogService>('workspaceSkillCatalogService');
