# @moonshot-ai/understand-core

Codebase knowledge-graph engine: tree-sitter static extraction (15 languages),
graph building/validation, fuzzy & semantic search, and git-hash-based
staleness/incremental updates.

Vendored from [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
(`understand-anything-plugin/packages/core`, MIT — see `LICENSE` in this
directory). The Dart/Swift WASM grammars in `assets/` come from the same
project's `tree-sitter-dart-wasm` / `tree-sitter-swift-wasm` packages.

This package is a pure engine library: it has no dependency on other
workspace packages and never calls an LLM itself — LLM-facing pieces are
prompt builders + JSON response parsers (`analyzer/llm-analyzer.ts`) that
callers wire to their own model client.
