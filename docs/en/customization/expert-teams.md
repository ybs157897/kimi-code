# Expert teams

Expert teams let one task be handled by multiple Agents with different responsibilities and an explicit workflow. The knowledge-graph expert team uses three ordered phases: static graph construction, deep semantic enrichment, and graph-quality review, coordinated by a lead.

## How the knowledge-graph team works

The lead dispatches these members in order:

- `graph-builder` calls `GraphBuild` and creates the structural graph of files, functions, classes, and relationships.
- `semantic-analyst` runs as an `AgentSwarm` worker after the graph build; the lead groups files into a small number of batches, each worker returns an analysis array, and the lead merges the results with `GraphSummarize`.
- `graph-reviewer` checks representative architecture questions such as authentication, persistence, request routing, background jobs, and configuration.

The lead may announce completion only after all three members return their findings through `SendMessage`. A successful `GraphBuild` means that the structural graph is ready; it does not mean that deep semantic analysis is complete.

## Create a directory expert team

A directory expert team needs no separate extension install. Put the team under the project config directory's `experts/` folder and reload the session:

```text
.kimi-desktop/experts/knowledge-graph-expert-team/
├── kimi.plugin.json
├── agents/
│   ├── knowledge-graph-expert-team-lead.md
│   ├── graph-builder.md
│   ├── semantic-analyst.md
│   └── graph-reviewer.md
└── skills/
    └── knowledge-graph-team-bootstrap/
        └── SKILL.md
```

`.kimi-code/experts/` is also supported. A minimal `kimi.plugin.json` looks like this:

```json
{
  "name": "knowledge-graph-expert-team",
  "version": "1.0.0",
  "expertType": "team",
  "agentName": "knowledge-graph-expert-team-lead",
  "agents": [
    "./agents/knowledge-graph-expert-team-lead.md",
    "./agents/graph-builder.md",
    "./agents/semantic-analyst.md",
    "./agents/graph-reviewer.md"
  ],
  "skills": ["./skills/knowledge-graph-team-bootstrap"],
  "teamInfo": {
    "leadAgent": "knowledge-graph-expert-team-lead",
    "memberAgents": ["graph-builder", "semantic-analyst", "graph-reviewer"]
  }
}
```

Each Agent file combines frontmatter with a Markdown prompt. Members should declare the tools they need, for example:

```markdown
---
name: semantic-analyst
description: Enriches the knowledge graph with deep semantic summaries and validates semantic search.
tools: [GraphSummarize, GraphSearch, SendMessage, TodoList]
---

Wait for GraphBuild to succeed, run GraphSummarize in batches, and send the complete result to team-lead with SendMessage.
```

The lead prompt should define the `TeamCreate`, `TeamSpawn`, `SendMessage`, and `TeamDelete` order. Each member prompt should define its inputs, tools, deliverable, and reporting protocol. This is similar to a code-based Extension in that the workflow is reusable and file-based, but an expert team is declarative Agent configuration rather than runtime code.

## Run the team

In the TUI, use `/experts` and select `knowledge-graph-expert-team`, or tell the main Agent:

```text
Start the knowledge-graph expert team: build the structural graph, perform deep semantic analysis, and review search quality. Summarize only after all three phases finish.
```

The lead must wait for the `graph-builder` result before entering `AgentSwarm`. Each cycle lists a bounded file batch with `GraphSummarize`, groups those files into a small number of work batches, launches one `semantic-analyst` worker per batch, and merges the returned `analyses` before starting the next cycle. The response that invokes `AgentSwarm` must contain no other tool call. If interrupted, resume failed items with `resume_agent_ids` instead of overwriting the whole pass.

## Expert teams versus Extensions

An Extension is executable TypeScript/JavaScript that can register tools, events, and slash commands. An expert team is a declarative collaboration package made of `kimi.plugin.json`, Agent files, and Skill files. Extensions add runtime behavior; expert teams add Agent roles and workflows. A Plugin can ship both.
