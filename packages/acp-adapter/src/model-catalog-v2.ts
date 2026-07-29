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
  let models: readonly any[];
  try {
    models = await klient.global.kosong.listModels();
  } catch {
    return [];
  }
  return models.map((m: any) => {
    const caps: readonly string[] = m.capabilities ?? [];
    return {
      id: m.model,
      name: m.display_name ?? m.model,
      thinkingSupported: caps.includes('thinking') || caps.includes('always_thinking'),
      alwaysThinking: caps.includes('always_thinking'),
      supportEfforts: m.support_efforts ?? [],
      defaultThinkingEffort: m.default_effort ?? 'on',
    };
  });
}

/**
 * Resolve the current default model id from Klient config.
 */
export async function resolveCurrentModelIdFromKlient(klient: Klient): Promise<string> {
  try {
    const cfg: any = await klient.global.config.get('config');
    if (cfg && typeof cfg === 'object' && typeof (cfg as any).defaultModel === 'string') {
      return (cfg as any).defaultModel;
    }
  } catch {
    // fall through
  }
  // Fallback: first model from the catalog
  try {
    const models = await klient.global.kosong.listModels();
    if (models.length > 0) return (models[0] as any).model;
  } catch {
    // empty
  }
  return '';
}
