---
"@moonshot-ai/agent-core-v2": patch
---

Consolidate `isRecord` type guard: add a shared export to `_base/utils/types.ts` and adopt it across 8 internal modules (agentFileCatalog, skillCatalog, kosongConfig, plugin, externalHooks, task, kosong/provider/kimi, goalQueue), removing 8 duplicated local definitions.
