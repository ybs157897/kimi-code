---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Consolidate type guards: add shared `isRecord` and `isNonEmptyString` exports to `utils/type-guards.ts` (kimi-code) and `_base/utils/types.ts` (agent-core-v2), adopting them across multiple modules to remove duplicated local definitions.
