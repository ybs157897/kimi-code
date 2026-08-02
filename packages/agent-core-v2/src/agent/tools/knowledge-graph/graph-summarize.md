Drive the optional LLM summarization pass over an existing knowledge graph.

The static graph (built by `GraphBuild`) has files, functions, classes and relationships, but node summaries start empty. This tool fills them in — making `GraphSearch` match by meaning, not just by name.

Calling conventions:
- **No arguments** → returns summarization progress plus the next batch of files waiting for summaries (with their function/class symbol lists).
- **`analyses`** → merges completed file analyses back onto the graph and reports progress.
- **`projectSummary`** → merges the project-level description/frameworks/layers (run once, after file batches are done).

Only use this when the user asked for a full/deep analysis (初始化/深度分析知识图谱), or semantic search quality matters and the graph is already built. It consumes model tokens proportionally to codebase size — for quick orientation, the static graph plus `GraphSearch` is usually enough. Do not start this pass without the user's intent; confirm scope for very large workspaces.
