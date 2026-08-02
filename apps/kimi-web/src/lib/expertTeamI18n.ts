const BUILTIN_EXPERT_KEYS: Readonly<Record<string, string>> = {
  'ai-data-copilot': 'aiDataCopilot',
  'aicoding-architecture-expert-team': 'aiCodingArchitecture',
  'code-review-team': 'codeReview',
  'openspec-doc-team': 'professionalDocument',
};

export function builtinExpertTranslationKey(
  pluginId: string,
  field: 'name' | 'description',
): string | undefined {
  const key = BUILTIN_EXPERT_KEYS[pluginId];
  return key === undefined ? undefined : `status.builtinExperts.${key}.${field}`;
}
