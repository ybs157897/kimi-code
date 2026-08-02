Search the workspace knowledge graph for files, functions, and classes by name or meaning.

Returns matching nodes with their file path and line range. Use it to answer "which code handles X?" or "where is Y defined?" before reading files — then open the reported locations with Read/Grep for details.

Use this tool when:
- The user asks architecture, module-ownership, or code-location questions spanning multiple files.
- You need an entry point into an unfamiliar part of the codebase.

The knowledge graph must exist first: if none has been built yet, call `GraphBuild` once (fast, static, no model tokens). If the graph is stale relative to the current git HEAD, prefer rebuilding before relying on the results.
