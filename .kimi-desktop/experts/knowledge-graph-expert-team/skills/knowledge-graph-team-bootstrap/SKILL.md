---
name: knowledge-graph-team-bootstrap
description: Orchestrate static graph construction, deep semantic enrichment, and graph quality review.
---

# Knowledge Graph Expert Team

This team has three ordered phases:

1. `graph-builder` runs `GraphBuild` and reports the exact file, node, edge, and duration statistics.
2. The lead enters `AgentSwarm` mode for semantic analysis: it lists a bounded batch with `GraphSummarize`, groups files into a few newline-delimited work batches, dispatches one `semantic-analyst` worker per batch, merges the returned analyses with `GraphSummarize`, and repeats until complete.
3. `graph-reviewer` queries representative architecture concepts and reports missing coverage, stale results, or suspicious relationships.

The lead must create the team before spawning members. Do not enter swarm mode before the graph builder has reported success. `AgentSwarm` must be the only tool call in the response where it is invoked. Do not report completion until the semantic pass and review both return through `SendMessage`.

All findings must include concrete graph statistics and file paths when available. Distinguish facts extracted from the graph from architectural inferences. If semantic analysis is too large, continue in batches and report the completed and remaining counts instead of silently stopping.
