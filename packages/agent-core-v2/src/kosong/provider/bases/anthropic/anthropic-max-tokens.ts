import { parseAnthropicModelVersion, type AnthropicModelVersion } from './anthropic-profile';

const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  'fable-5': 128000,
  'mythos-5': 128000,
  'opus-4-8': 128000,
  'opus-4-7': 128000,
  'opus-4-6': 128000,
  'opus-4-5': 64000,
  'opus-4-1': 32000,
  'opus-4-0': 32000,
  'opus-4': 32000,
  'sonnet-5': 128000,
  'sonnet-4-6': 128000,
  'sonnet-4-5': 64000,
  'sonnet-4-0': 64000,
  'sonnet-4': 64000,
  'haiku-4-5': 64000,
  'haiku-4': 64000,
  'opus-3-5': 8192,
  'sonnet-3-5': 8192,
  'sonnet-3-7': 8192,
  'haiku-3-5': 8192,
  'opus-3': 4096,
  'sonnet-3': 4096,
  'haiku-3': 4096,
};

const FALLBACK_MAX_TOKENS = 128000;

function lookupClaudeCeiling(version: AnthropicModelVersion): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    for (let candidate = minor; candidate >= 0; candidate--) {
      const ceiling = CEILING_BY_FAMILY_VERSION[`${family}-${major}-${candidate}`];
      if (ceiling !== undefined) return ceiling;
    }
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

export function resolveDefaultMaxTokens(model: string, override?: number): number {
  const parsed = parseAnthropicModelVersion(model, true);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}
