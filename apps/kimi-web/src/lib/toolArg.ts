// apps/kimi-web/src/lib/toolArg.ts
// Shared tool-argument parsing helpers used by toolMeta.ts and toolDiff.ts.

/** Parse the JSON-stringified `arg` into a record, or null for plain strings. */
export function parseToolArg(arg: string): Record<string, unknown> | null {
  const s = arg.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
