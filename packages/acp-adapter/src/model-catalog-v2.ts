/**
 * Klient-based model catalog for the ACP configOptions surface.
 *
 * Replaces `model-catalog.ts` which depends on the legacy `KimiHarness` and
 * `@moonshot-ai/agent-core`. Uses `klient.global.kosong.listModels()` /
 * `klient.global.auth.status()` to derive the same `AcpModelEntry` shape
 * the ACP adapter renders in its model picker.
 */

import type { Klient } from '@moonshot-ai/klient';
import type { AcpModelEntry } from './types';

/**
 * Build the model catalog from Klient instead of the legacy harness.
 */
export async function listModelsFromKlient(
  klient: Klient,
): Promise<readonly AcpModelEntry[]> {
  let models: Awaited<ReturnType<Klient['global']['kosong']['listModels']>>;
  try {
    models = await klient.global.kosong.listModels();
  } catch {
    return [];
  }
  return models.map((model) => {
    const capabilities = model.capabilities ?? [];
    return {
      id: model.model,
      name: model.display_name ?? model.model,
      thinkingSupported:
        capabilities.includes('thinking') ||
        capabilities.includes('always_thinking'),
      alwaysThinking: capabilities.includes('always_thinking'),
      supportEfforts: model.support_efforts ?? [],
      defaultThinkingEffort: model.default_effort ?? 'on',
    };
  });
}

/**
 * Resolve the current default model id from Klient config.
 */
export async function resolveCurrentModelIdFromKlient(klient: Klient): Promise<string> {
  try {
    const defaultModel = await klient.global.config.get<string>('defaultModel');
    if (defaultModel.length > 0) return defaultModel;
  } catch {
    // fall through
  }
  // Fallback: first model from the catalog
  try {
    const models = await klient.global.kosong.listModels();
    if (models.length > 0) return models[0]!.model;
  } catch {
    // empty
  }
  return '';
}
