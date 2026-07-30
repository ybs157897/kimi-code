---
"kimi-web": patch
---

Deduplicate shared utilities: extract `parseToolArg` into `lib/toolArg.ts` (was duplicated in `toolDiff.ts` and `toolMeta.ts`), and consolidate `escapeHtml` to the existing export in `lib/searchHighlight.ts` (was duplicated in `filePreviewHighlight.ts` and `FilePreview.vue`).
