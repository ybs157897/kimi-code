---
"@moonshot-ai/kimi-code": patch
---

Consolidate `isRecord` type guard: add a shared export to `utils/type-guards.ts` and adopt it across 3 TUI modules (mcp-oauth, message-replay, goal-queue-store), removing duplicated local definitions.
