---
name: knowledge-graph
description: Analyze and navigate the codebase through a tree-sitter knowledge graph. Use when the user asks to initialize the project as a knowledge graph (初始化知识图谱), or when answering architecture, module-ownership, or code-location questions that span multiple files — search the graph first instead of reading files one by one.
---

# Knowledge Graph

The workspace can be analyzed into a knowledge graph: every source file,
function, and class becomes a node, with containment and import relationships
as edges. Building is fast, fully static (tree-sitter), and consumes no model
tokens. The graph is persisted in the project config directory and survives
session restarts.


## When to use

- The user asks to "initialize the project as a knowledge graph" (or similar).
- Architecture questions: "how is this project structured?", "which layer
  handles X?"
- Ownership/location questions spanning multiple files: "where is login
  handled?", "which module owns Y?"
- Before large changes: locate every file related to the area being modified.

For single-file questions or when you already know the file, Read/Grep
directly — the graph is for orientation, not a replacement for reading code.

## Workflow

1. **Check/build.** If no graph exists yet (or the user asked to refresh it),
   call `GraphBuild` once. It is cheap — do not ask for confirmation unless
   the workspace is huge. If results ever look outdated, rebuild.
2. **Search.** Call `GraphSearch` with a concept or symbol name. Each hit
   carries `filePath` and `lineRange`.
3. **Read the code.** Open the reported locations with Read/Grep and answer
   from the actual source. The graph gives you the map; the code is the
   territory.

## Notes

- Graph nodes carry empty summaries until LLM summarization runs — rely on
  names, types, and locations, not on the summary field.
- The graph is git-aware: after large commits, prefer rebuilding before
  trusting stale locations.

## Deep summarization (optional, on user request)

The static graph knows structure but not meaning. When the user asks for a
full/deep analysis (完整分析、深度初始化知识图谱), run this pass to fill in
node summaries so `GraphSearch` matches by meaning. It costs model tokens
roughly proportional to codebase size — never start it unprompted, and for
very large workspaces confirm scope first.

1. `GraphBuild` (if no fresh graph exists).
2. Loop: call `GraphSummarize` with no arguments to get the next batch of
   files, then summarize them. To keep the main context small, fan batches
   out to subagents (Agent tool): each subagent Reads its assigned files and
   returns the `analyses` JSON array for them (shape printed by the tool).
   Run a few subagents in parallel on independent batches.
3. After each batch, call `GraphSummarize` with the collected `analyses` to
   merge them. Report progress occasionally
   (`Progress: X/Y files summarized`).
4. When every file is summarized, finish with one `GraphSummarize` call
   carrying `projectSummary` (description, frameworks, layers derived from
   the directory layout).

Partial progress persists — an interrupted pass resumes where it left off.

For a complete build, prefer the `knowledge-graph-expert-team` workflow when
the directory expert package is available under `.kimi-desktop/experts/` or
`.kimi-code/experts/`. The lead creates the team first, then runs these phases
in order: `graph-builder` calls `GraphBuild`, the lead enters `AgentSwarm` and
dispatches one `semantic-analyst` worker per grouped batch from a bounded
`GraphSummarize` result, merges the arrays, and
`graph-reviewer` checks representative architecture queries. Do not claim deep
semantic completion after only `GraphBuild` succeeds. Every member must return
authoritative findings to the lead with `SendMessage`.

If the package is not installed, create it using the documented directory
package layout: `kimi.plugin.json`, `agents/`, and `skills/` under
`.kimi-desktop/experts/knowledge-graph-expert-team/`. The manifest declares
`expertType: "team"`, one lead, and declared members. Create the runtime team
with `TeamCreate`, launch members with `TeamSpawn`, and call `TeamDelete` only
after all reports arrive. See the expert-team customization guide for the
complete manifest and Agent file contract.
