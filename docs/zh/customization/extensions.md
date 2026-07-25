# 代码型扩展（Extensions）

代码型扩展让你用 TypeScript/JavaScript 在 Kimi Code 进程内运行自定义逻辑。与[声明式插件](./plugins.md)不同，扩展是一段**可执行代码**：它可以订阅事件、注册工具、注册斜杠命令，并在运行时驱动会话。

扩展使用 [jiti](https://github.com/unjs/jiti) 在运行时加载，无需编译。改完代码后在 TUI 里输入 `/reload` 即可热重载。

## 快速开始

在项目根目录创建 `.kimi-code/extensions/`，放入一个 `.ts` 文件：

```bash
mkdir -p .kimi-code/extensions
```

`.kimi-code/extensions/my-ext.ts`：

```ts
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI) => {
  // 1. 订阅事件
  api.on('tool_result', (event) => {
    console.log(`[${event.toolName}] ${event.isError ? '失败' : '完成'}`);
  });

  // 每轮结束时在 TUI 状态行提示（不触发新一轮对话）
  api.on('turn_end', (_event, ctx) => {
    ctx.notify('会话结束');
  });

  // 2. 注册一个模型可调用的工具
  api.registerTool({
    name: 'echo',
    description: '原样返回输入文本。',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    async execute({ args }) {
      return { output: `echo: ${args['message']}` };
    },
  });

  // 3. 注册一个斜杠命令
  api.registerCommand('greet', {
    description: '向模型问好。',
    prompt: (args) => `请打个招呼${args ? `，提到 ${args}` : ''}。`,
  });
};
```

启动 TUI，扩展会自动加载。命令以 `<扩展id>:<命令名>` 的形式出现（如 `/my-ext:greet`），可在 `/` 补全里看到。

## 加载位置

扩展按以下顺序发现（路径去重，先发现者优先）：

1. **项目本地**：`<项目根>/.kimi-code/extensions/`
2. **全局**：`~/.kimi-code/extensions/`
3. 显式配置的路径（如有）

发现规则（最多递归一层）：

- 直接的 `*.ts` / `*.js` / `*.mjs` 文件
- 子目录里的 `index.ts` / `index.js` / `index.mjs`
- 子目录的 `package.json` 里声明了 `kimi.extensions` 字段：

  ```json
  {
    "name": "my-extension-pack",
    "kimi": { "extensions": ["./src/index.ts"] }
  }
  ```

扩展 id 由文件名派生（小写、非字母数字字符替换为 `-`），用于命令命名空间。

## 可用的 import

扩展从 `@moonshot-ai/agent-core/extension` 导入公开 API：

```ts
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';
```

jiti 加载器还会把以下宿主包别名到 Kimi Code 自带的副本，因此**无需自行安装**：

- `@moonshot-ai/agent-core` / `@moonshot-ai/agent-core/extension`
- `@moonshot-ai/protocol`
- `@moonshot-ai/kosong`

## ExtensionAPI

### 事件订阅 `api.on(event, handler)`

| 事件 | 触发时机 | 说明 |
|---|---|---|
| `session_start` | 会话启动/恢复 | |
| `session_shutdown` | 会话关闭 | |
| `turn_start` | 一轮对话开始 | `event.prompt` 是用户输入文本 |
| `turn_end` | 一轮对话结束 | |
| `tool_call` | 工具调用前 | 返回 `{ block: true, reason }` 可拒绝调用 |
| `tool_result` | 工具调用后 | `event.output` 截断为 2000 字符 |

事件处理器接收 `(event, ctx)`，`ctx` 是 [`ExtensionContext`](#extensioncontext)。

### 注册工具 `api.registerTool(tool)`

```ts
api.registerTool({
  name: 'my_tool',           // 必须全局唯一
  description: '...',
  parameters: { type: 'object', properties: { ... }, required: [...] },
  disclosure: 'inline',      // 可选：'inline'（默认）或 'deferred'
  async execute({ args, signal, turnId, toolCallId }) {
    return { output: '结果文本', isError: false };
  },
});
```

`execute` 在 Kimi Code 进程内直接运行（不经过 RPC 反弹）。`parameters` 是标准 JSON Schema。

### 注册命令 `api.registerCommand(name, command)`

```ts
api.registerCommand('my-cmd', {
  description: '命令描述',
  // prompt 风格：返回的字符串作为用户消息发给模型
  prompt: (args) => `请执行：${args}`,
});
```

命令通过 `/<扩展id>:<命令名>` 调用（如 `/my-ext:my-cmd`）。

## ExtensionContext

事件处理器收到的 `ctx` 提供：

| 成员 | 说明 |
|---|---|
| `ctx.cwd` | 当前会话的工作目录 |
| `ctx.sessionId` | 当前会话 id |
| `ctx.sendUserMessage(content)` | 向 agent 发送用户消息并触发一轮对话 |
| `ctx.notify(message)` | 在 TUI 显示一行状态提示；不触发新一轮对话，也不进入模型上下文。提示类信息请用它，不要用 `sendUserMessage` 或 `console.log`（全屏 TUI 下看不见） |
| `ctx.setModel(modelAlias)` | 设置当前会话的模型 |
| `ctx.setActiveTools(toolNames)` | 限制当前会话启用的工具集 |
| `ctx.getActiveTools()` | 当前启用的工具名列表 |

## 热重载

在 TUI 输入 `/reload`，扩展会被重新发现和加载。编辑扩展代码后无需重启 Kimi Code。

## 与声明式插件的关系

| | 代码型扩展（本文） | [声明式插件](./plugins.md) |
|---|---|---|
| 形态 | TS/JS 代码 | `kimi.plugin.json` 清单 + 资源 |
| 能力 | 事件订阅、自定义工具、斜杠命令、运行时 action | skills、MCP servers、hooks、commands(.md)、sessionStart |
| 执行 | 进程内（jiti） | 静态资源 + MCP 子进程 |
| 目录 | `.kimi-code/extensions/` | `~/.kimi-code/plugins/managed/` |

两者并存，互不影响。

## 示例

更多示例见 [`packages/agent-core/examples/extensions/`](../../../packages/agent-core/examples/extensions/)。
