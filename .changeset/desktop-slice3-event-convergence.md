---
"@moonshot-ai/kimi-code": patch
---

web: Make the desktop event stream converge on reconnect — subscriptions now resume from a durable cursor, replay missed frames from a bounded journal (or resync when they cannot be covered), and detach cleanly on unsubscribe, so switching or reopening a session no longer drops or duplicates messages.
