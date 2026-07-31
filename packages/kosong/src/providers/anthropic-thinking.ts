import type { ThinkingEffort } from '#/provider';

import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  type AnthropicModelProfile,
} from './anthropic-profile';

export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
export const CLEAR_THINKING_EDIT = 'clear_thinking_20251015';

function requiresAdaptiveThinking(efforts: readonly string[]): boolean {
  return efforts.some(
    (effort) => effort !== 'low' && effort !== 'medium' && effort !== 'high',
  );
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
      // Opting out of adaptive also opts out of the effort param: budget
      // efforts must go out as pure `budget_tokens` payloads instead of
      // inheriting `supportsEffortParam` from an adaptive inferred profile.
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
    supportsEffortParam:
      requiresAdaptiveThinking(supportEfforts) || inferred.supportsEffortParam,
  };
}

export function budgetTokensForEffort(effort: ThinkingEffort): number | undefined {
  if (effort === 'low') return 1024;
  if (effort === 'medium') return 4096;
  if (effort === 'on' || effort === 'high') return 32_000;
  return undefined;
}
