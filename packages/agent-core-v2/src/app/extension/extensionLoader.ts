/**
 * `extension` domain (L3) — App-scope extension loading contract.
 *
 * Defines `IExtensionLoaderService`, the stateless capability that discovers
 * and evaluates code extensions for one workspace. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ExtensionLoadResult } from './extension.types';

export interface LoadExtensionsInput {
  readonly cwd: string;
}

export interface IExtensionLoaderService {
  readonly _serviceBrand: undefined;

  load(input: LoadExtensionsInput): Promise<ExtensionLoadResult>;
}

export const IExtensionLoaderService: ServiceIdentifier<IExtensionLoaderService> =
  createDecorator<IExtensionLoaderService>('extensionLoaderService');
