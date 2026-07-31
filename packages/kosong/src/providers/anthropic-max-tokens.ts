import { parseAnthropicModelVersion, type AnthropicModelVersion } from './anthropic-profile';

/**
 * Per-version default output ceilings sourced from Anthropic's Messages
 * API model cards (platform.claude.com/docs/en/about-claude/models/overview).
 * Values are the documented synchronous Messages-API maximum — we send
 * the full ceiling because Claude 4 + interleaved-thinking shares this
 * budget with encrypted reasoning, so anything below the documented cap
 * can silently truncate mid-`tool_use`.
 *
 * Keys are `<family>-<major>[-<minor>]`. Lookups try the most specific
 * key first, then the nearest lower catalogued minor of the same
 * family/major (a not-yet-catalogued `opus-4-8` reuses `opus-4-7`'s
 * ceiling), and finally the family/major-only baseline entry.
 */
const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  // Claude Fable 5 documents a 128k output ceiling.
  'fable-5': 128000,
  'mythos-5': 128000,
  // Claude Opus per minor version. 4.6 through 4.8 document a 128k cap;
  // 4.5 ships at 64k; 4.1 and the dated 4.0 release stay at 32k.
  'opus-4-8': 128000,
  'opus-4-7': 128000,
  'opus-4-6': 128000,
  'opus-4-5': 64000,
  'opus-4-1': 32000,
  'opus-4-0': 32000,
  'opus-4': 32000,
  // Claude Sonnet 5 and 4.6 document a 128k ceiling; older 4.x stays at 64k.
  'sonnet-5': 128000,
  'sonnet-4-6': 128000,
  'sonnet-4-5': 64000,
  'sonnet-4-0': 64000,
  'sonnet-4': 64000,
  // Claude Haiku 4.5 is 64k; the family-only entry keeps future dated
  // 4.x Haiku releases on the same ceiling.
  'haiku-4-5': 64000,
  'haiku-4': 64000,
  // Claude 3.5 / 3.7 documented at 8192 (standard endpoint).
  'opus-3-5': 8192,
  'sonnet-3-5': 8192,
  'sonnet-3-7': 8192,
  'haiku-3-5': 8192,
  // Original Claude 3 generation.
  'opus-3': 4096,
  'sonnet-3': 4096,
  'haiku-3': 4096,
};

const FALLBACK_MAX_TOKENS = 128000;

function lookupClaudeCeiling(version: AnthropicModelVersion): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    // Exact minor first, then walk down to the nearest catalogued minor:
    // a newer minor release inherits at least its predecessor's ceiling
    // (Anthropic has never lowered the cap within a major), so a
    // not-yet-catalogued 4.8 reuses 4.7's value instead of dropping to
    // the family baseline. The regex caps minors at two digits, so this
    // walk is bounded.
    for (let candidate = minor; candidate >= 0; candidate--) {
      const ceiling = CEILING_BY_FAMILY_VERSION[`${family}-${major}-${candidate}`];
      if (ceiling !== undefined) return ceiling;
    }
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

/**
 * Resolve the default `max_tokens` for an Anthropic request.
 *
 * Precedence:
 *   1. Caller-provided `override` (e.g. `models.<alias>.maxOutputSize`
 *      from the harness config) — honored when present so users can
 *      intentionally lower the budget (handy for forcing truncation
 *      in tests) or raise it on a model we don't yet know about.
 *   2. When the model id parses to a known Claude family + version,
 *      the override is clamped to the documented Messages-API ceiling
 *      so we never send a value the server would reject.
 *   3. With no override and no recognized version, fall back to
 *      {@link FALLBACK_MAX_TOKENS}.
 */
export function resolveDefaultMaxTokens(model: string, override?: number): number {
  const parsed = parseAnthropicModelVersion(model, true);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}
