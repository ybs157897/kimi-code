import type { ThinkingEffort } from '#/kosong/contract/provider';

import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  type AnthropicModelProfile,
} from './anthropic-profile';
import type { AnthropicGenerationKwargs } from './anthropic-types';

export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
const CLEAR_THINKING_EDIT = 'clear_thinking_20251015';

function requiresAdaptiveThinking(efforts: readonly string[]): boolean {
  return efforts.some((effort) => effort !== 'low' && effort !== 'medium' && effort !== 'high');
}

export function resolveThinkingProfile(
  model: string,
  supportEfforts: readonly string[] | undefined,
  adaptiveThinking: boolean | undefined,
): AnthropicModelProfile {
  const inferred = inferAnthropicModelProfile(model);
  if (adaptiveThinking === false) {
    return {
      ...inferred,
      mode: 'budget',
      efforts: supportEfforts ?? BUDGET_THINKING_EFFORTS,
      supportsEffortParam: false,
    };
  }

  if (adaptiveThinking === true) {
    return {
      ...inferred,
      mode: 'adaptive',
      efforts: supportEfforts ?? inferred.efforts,
      supportsEffortParam: true,
    };
  }

  if (supportEfforts === undefined) {
    return inferred;
  }
  return {
    ...inferred,
    mode: requiresAdaptiveThinking(supportEfforts) ? 'adaptive' : inferred.mode,
    efforts: supportEfforts,
    supportsEffortParam: requiresAdaptiveThinking(supportEfforts) || inferred.supportsEffortParam,
  };
}

export function budgetTokensForEffort(effort: ThinkingEffort): number | undefined {
  if (effort === 'low') return 1024;
  if (effort === 'medium') return 4096;
  if (effort === 'on' || effort === 'high') return 32_000;
  return undefined;
}

/**
 * The keep context-management edit, overlaid by the base on top of any
 * thinking encoding: appends the context-management beta and replaces any
 * prior clear-thinking edit with one carrying this keep value.
 */
export function applyThinkingKeep(
  kwargs: AnthropicGenerationKwargs,
  keep: string,
): AnthropicGenerationKwargs {
  const current = kwargs.betaFeatures ?? [];
  const betaFeatures = current.includes(CONTEXT_MANAGEMENT_BETA)
    ? current
    : [...current, CONTEXT_MANAGEMENT_BETA];
  const existingEdits = kwargs.contextManagement?.edits ?? [];
  const edits = [
    { type: CLEAR_THINKING_EDIT, keep },
    ...existingEdits.filter((edit) => edit.type !== CLEAR_THINKING_EDIT),
  ];
  return {
    contextManagement: { edits },
    betaFeatures,
  };
}
