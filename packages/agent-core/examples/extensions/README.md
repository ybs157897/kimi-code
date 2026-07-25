# Code-based extension examples

Drop any of these (or your own `.ts` file) into `.kimi-code/extensions/` (project)
or `~/.kimi-code/extensions/` (global) to load it. Extensions are TypeScript
modules whose **default export** is a factory function receiving the
`ExtensionAPI`. They are loaded at runtime by [jiti](https://github.com/unjs/jiti),
so no build step is required.

```bash
# Project-local (scoped to one repo)
mkdir -p .kimi-code/extensions
cp ../../packages/agent-core/examples/extensions/log-tool-calls.ts .kimi-code/extensions/

# Global (available everywhere)
mkdir -p ~/.kimi-code/extensions
cp ../../packages/agent-core/examples/extensions/echo-tool.ts ~/.kimi-code/extensions/
```

After editing an extension, run `/reload` in the TUI to pick up the changes.

## Examples

- [`echo-tool.ts`](./echo-tool.ts) — registers a custom tool the model can call.
- [`log-tool-calls.ts`](./log-tool-calls.ts) — subscribes to the `tool_call` /
  `tool_result` events.
- [`hello-command.ts`](./hello-command.ts) — registers a `/hello` slash command.
- [`turn-end-notify.ts`](./turn-end-notify.ts) — shows a non-blocking TUI status
  line on `turn_end` via `ctx.notify`.

## What you can import

Extensions import the public API from `@moonshot-ai/agent-core/extension`:

```ts
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';
```

The jiti loader also aliases `@moonshot-ai/agent-core`, `@moonshot-ai/protocol`,
and `@moonshot-ai/kosong` to the host's bundled copies, so you don't need to
install them yourself.
