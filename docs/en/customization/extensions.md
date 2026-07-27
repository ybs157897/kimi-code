# Code-based extensions

Code-based extensions let you run custom TypeScript/JavaScript logic inside the
Kimi Code process. Unlike [declarative plugins](./plugins.md), an extension is
**executable code**: it can subscribe to events, register tools, register slash
commands, and drive the session at runtime.

Extensions are loaded at runtime by [jiti](https://github.com/unjs/jiti), so no
build step is needed. After editing, run `/reload` in the TUI or web UI to pick
up changes.

## Quick start

Create `.kimi-code/extensions/` at your project root and drop in a `.ts` file:

```bash
mkdir -p .kimi-code/extensions
```

`.kimi-code/extensions/my-ext.ts`:

```ts
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI) => {
  // 1. Subscribe to events
  api.on('tool_result', (event) => {
    console.log(`[${event.toolName}] ${event.isError ? 'failed' : 'ok'}`);
  });

  // Non-blocking TUI status line when a turn ends (does not start a new turn)
  api.on('turn_end', (_event, ctx) => {
    ctx.notify('Turn ended');
  });

  // 2. Register a tool the model can call
  api.registerTool({
    name: 'echo',
    description: 'Echo back the input text.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    async execute({ args }) {
      return { output: `echo: ${args['message']}` };
    },
  });

  // 3. Register a slash command
  api.registerCommand('greet', {
    description: 'Greet the model.',
    prompt: (args) => `Please say hello${args ? ` and mention ${args}` : ''}.`,
  });
};
```

Start the TUI or web UI and the extension loads automatically. Commands appear
as `<extensionId>:<commandName>` (e.g. `/my-ext:greet`) in `/` autocomplete.

## Extension locations

Extensions are discovered in this order (paths are deduped; first wins):

1. **Project-local**: `<project root>/.kimi-code/extensions/`
2. **Global**: `~/.kimi-code/extensions/`
3. Explicitly configured paths (if any)

Discovery rules (at most one level deep):

- Direct `*.ts` / `*.js` / `*.mjs` files
- A subdirectory's `index.ts` / `index.js` / `index.mjs`
- A subdirectory whose `package.json` declares a `kimi.extensions` field:

  ```json
  {
    "name": "my-extension-pack",
    "kimi": { "extensions": ["./src/index.ts"] }
  }
  ```

The extension id is derived from the file name (lowercased, non-alphanumeric
characters replaced with `-`) and is used for command namespacing.

## Available imports

Extensions import the public API from `@moonshot-ai/agent-core/extension`:

```ts
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';
```

The jiti loader also aliases the following host packages to Kimi Code's bundled
copies, so you **do not need to install them yourself**:

- `@moonshot-ai/agent-core` / `@moonshot-ai/agent-core/extension`
- `@moonshot-ai/protocol`
- `@moonshot-ai/kosong`

## ExtensionAPI

### Event subscription `api.on(event, handler)`

| Event | When it fires | Notes |
|---|---|---|
| `session_start` | session starts/resumes | |
| `session_shutdown` | session closes | |
| `turn_start` | a turn begins | `event.prompt` is the user input text |
| `turn_end` | a turn ends | |
| `tool_call` | before a tool call | return `{ block: true, reason }` to deny |
| `tool_result` | after a tool call | `event.output` truncated to 2000 chars |

Handlers receive `(event, ctx)` where `ctx` is an
[`ExtensionContext`](#extensioncontext).

### Register a tool `api.registerTool(tool)`

```ts
api.registerTool({
  name: 'my_tool',           // must be globally unique
  description: '...',
  parameters: { type: 'object', properties: { ... }, required: [...] },
  disclosure: 'inline',      // optional: 'inline' (default) or 'deferred'
  async execute({ args, signal, turnId, toolCallId }) {
    return { output: 'result text', isError: false };
  },
});
```

`execute` runs directly inside the Kimi Code process (no RPC bounce).
`parameters` is a standard JSON Schema.

### Register a command `api.registerCommand(name, command)`

```ts
api.registerCommand('my-cmd', {
  description: 'Command description',
  // prompt-style: the returned string is sent to the model as a user message
  prompt: (args) => `Please do: ${args}`,
});
```

Commands are invoked via `/<extensionId>:<commandName>`
(e.g. `/my-ext:my-cmd`).

## ExtensionContext

The `ctx` passed to event handlers exposes:

| Member | Description |
|---|---|
| `ctx.cwd` | the session's working directory |
| `ctx.sessionId` | the current session id |
| `ctx.sendUserMessage(content)` | send a user message to the agent (triggers a turn) |
| `ctx.notify(message)` | show a non-blocking TUI status line; does not start a turn or enter model context. Prefer this for tips — not `sendUserMessage` or `console.log` (invisible under the fullscreen TUI) |
| `ctx.setModel(modelAlias)` | set the session's model |
| `ctx.setActiveTools(toolNames)` | restrict the session's enabled tool set |
| `ctx.getActiveTools()` | currently enabled tool names |

## Hot reload

Run `/reload` in the TUI or web UI to re-discover and re-load extensions. No
Kimi Code restart is needed after editing extension code.

## Relationship to declarative plugins

| | Code-based extensions (this doc) | [Declarative plugins](./plugins.md) |
|---|---|---|
| Form | TS/JS code | `kimi.plugin.json` manifest + assets |
| Capabilities | events, custom tools, slash commands, runtime actions | skills, MCP servers, hooks, commands(.md), sessionStart |
| Execution | in-process (jiti) | static assets + MCP subprocess |
| Location | `.kimi-code/extensions/` | `~/.kimi-code/plugins/managed/` |

The two coexist and do not interfere.

## Examples

More examples in
[`packages/agent-core/examples/extensions/`](https://github.com/MoonshotAI/kimi-code/tree/main/packages/agent-core/examples/extensions).
