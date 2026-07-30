---
"@moonshot-ai/agent-core-v2": patch
---

Consolidate `errorMessage` helper: add a shared export to `_base/errors/errorMessage.ts` and adopt it across 6 modules (agentRoots, agentFileDiscovery, team-spawn, team-create, team-delete, send-message), removing duplicated local definitions.
