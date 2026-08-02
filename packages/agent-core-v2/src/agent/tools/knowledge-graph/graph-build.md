Build (or rebuild) the knowledge graph of the current workspace.

Runs a fast, purely static tree-sitter analysis — every source file is parsed into nodes (files, functions, classes) and edges (containment, imports). No model tokens are consumed by this tool. The graph is persisted inside the project config directory and then served by the `GraphSearch` tool.

Use this tool when:
- The user asks to initialize, build, or refresh the knowledge graph ("把项目初始化成知识图谱", "build the knowledge graph").
- `GraphSearch` reports the graph is missing or stale and structural understanding is needed.

After building, prefer `GraphSearch` over broad file-by-file reading for architecture/location questions.
