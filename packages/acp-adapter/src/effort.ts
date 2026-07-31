export function effortStringOrUndefined(effort: unknown): string | undefined {
  if (typeof effort !== 'string') return undefined;
  const trimmed = effort.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
