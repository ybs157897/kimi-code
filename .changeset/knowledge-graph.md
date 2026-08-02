---
"@moonshot-ai/kimi-code": minor
---

Add an experimental workspace knowledge graph: fast tree-sitter static analysis builds a searchable map of files, functions, and classes that the agent can query on demand for architecture and code-location questions, with an optional LLM summarization pass for semantic search. Enable `KIMI_CODE_EXPERIMENTAL_KNOWLEDGE_GRAPH=1`, then ask the agent to initialize the knowledge graph for the current project.
