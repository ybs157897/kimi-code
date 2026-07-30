---
"@moonshot-ai/agent-core-v2": patch
---

Consolidate `errorMessage` helper: add a shared export to `_base/errors/errorMessage.ts` and adopt it across 12 modules (agentRoots, agentFileDiscovery, team-spawn, team-create, team-delete, send-message, question-background-task, subagent-task, process-task, toolExecutorService, externalHooks/runner, taskService, mirrorAgentRun), removing duplicated local definitions.
