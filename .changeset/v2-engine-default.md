---
"@moonshot-ai/kimi-code": minor
---

Default to the v2 engine for all CLI modes (interactive TUI, `kimi -p`, and subcommands). `--agent` and `--agent-file` are now available in `kimi -p` without setting `KIMI_CODE_EXPERIMENTAL_FLAG`. The legacy v1 engine is reachable through the `KIMI_CODE_V1_FALLBACK` env var for emergency rollback only.
