---
"@moonshot-ai/agent-core-v2": patch
---

Refactor internal file-write utilities: extract duplicated atomic-rename helpers (`unlinkTargetForWindows`, `cleanupTemp`, `makeTmpPath`) in `_base/utils/fs`, add shared `isEnoent`/`isErrno` errno guards, and optimize `BlobStoreService.has` to use a direct read instead of a prefix list scan.
