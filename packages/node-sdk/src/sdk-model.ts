/*
 * SDK-local model alias helper — effectiveModelAlias and replay limit
 * utilities, extracted from the legacy agent-core package.
 *
 * These are thin helpers that the SDK's public barrel re-exports.  The
 * canonical model resolution logic lives in the v2 `IModelCatalog` service;
 * this module provides the static, config-local
 * projection that the catalog UI / login flow need without a live runtime.
 */

import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '@moonshot-ai/kosong/providers/anthropic-profile';

import type { ModelAlias } from '#/sdk-config';

/**
 * Apply runtime overlays (overrides, Anthropic profile defaults) to a model
 * alias.  Returns a new object — never mutates the input.
 */
export function effectiveModelAlias(
  alias: ModelAlias,
  providerType?: string,
): ModelAlias {
  const { overrides, ...base } = alias;
  const effective: ModelAlias = overrides === undefined ? alias : { ...base, ...overrides };

  const typedOverrides = (overrides ?? {}) as Partial<
    Pick<ModelAlias, 'supportEfforts' | 'defaultEffort'>
  >;
  const suppEfforts = typedOverrides.supportEfforts;
  const defEffort = typedOverrides.defaultEffort;
  if (
    suppEfforts !== undefined &&
    defEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !suppEfforts.includes(effective.defaultEffort)
  ) {
    effective.defaultEffort = undefined;
  }

  const maxInputSize = effective.maxInputSize;
  const maxContextSize = effective.maxContextSize;
  const clamped =
    maxInputSize !== undefined && maxInputSize > (maxContextSize ?? 0)
      ? ({ ...effective, maxInputSize: maxContextSize }) as ModelAlias
      : effective;

  return withAnthropicProfile(clamped, providerType);
}

export function effectiveModelAliases(
  models: Record<string, ModelAlias>,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, effectiveModelAlias(model)]),
  );
}

function withAnthropicProfile(model: ModelAlias, providerType?: string): ModelAlias {
  const protocol = model.protocol ?? providerType;
  const profile =
    providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
      ? (matchKnownAnthropicModelProfile(model.model) ?? matchUnknownClaudeProfile(model.model))
      : matchKnownAnthropicModelProfile(model.model);
  if (profile === undefined) return model;

  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
  const supportEfforts =
    model.supportEfforts ??
    (model.adaptiveThinking === false
      ? [...BUDGET_THINKING_EFFORTS]
      : [...profile.efforts]);

  return {
    ...model,
    capabilities: hasCapability ? capabilities : [...capabilities, capability],
    supportEfforts,
    defaultEffort:
      model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
  };
}

// ── Replay helpers ───────────────────────────────────────────────────────

/**
 * Minimal compatible AgentReplayRecord type for the turn-boundary predicate.
 * Mirrors the legacy agent-core replay record.
 */

export interface AgentReplayRecord {
  readonly time: number;
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly origin?: {
      readonly kind?: string;
      readonly name?: string;
      readonly trigger?: string;
      readonly phase?: string;
    };
  };
}

/**
 * User-turn boundary detection over an agent's replay records.
 *
 * A record starts a new user turn when it is a user-role message that came
 * from an actual user action. System-originated user messages continue the
 * current turn instead, with the exception of `goal_continuation` prompts.
 */
export function isAgentReplayUserTurnRecord(record: AgentReplayRecord): boolean {
  if (record.type !== 'message') return false;
  const msg = record.message;
  if (msg?.role !== 'user') return false;
  switch (msg.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
      return msg.origin.trigger === 'user-slash';
    case 'plugin_command':
      return msg.origin.trigger === 'user-slash';
    case 'shell_command':
      return msg.origin.phase === 'input';
    case 'background_task':
    case 'compaction_summary':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'injection':
    case 'retry':
      return false;
    case 'system_trigger':
      return msg.origin.name === 'goal_continuation';
  }
  return false;
}

/**
 * Keep only the most recent `maxTurns` user turns of a replay. `undefined`
 * keeps the full replay; `0` or negative returns an empty replay.
 */
export function limitAgentReplayByTurns<T extends AgentReplayRecord>(
  records: readonly T[],
  maxTurns?: number,
): readonly T[] {
  if (maxTurns === undefined) return records;
  if (maxTurns <= 0) return [];
  const turnStarts = records.flatMap((record, index) =>
    isAgentReplayUserTurnRecord(record) ? [index] : [],
  );
  if (turnStarts.length <= maxTurns) return records;
  return records.slice(turnStarts[turnStarts.length - maxTurns]);
}
