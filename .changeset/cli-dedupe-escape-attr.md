---
"@moonshot-ai/kimi-code": patch
---

Deduplicate `escapeAttribute` helper: extract the shared HTML attribute escaping function into `tui/utils/html-escape.ts` (was duplicated verbatim in `media-url.ts` and `image-placeholder.ts`).
