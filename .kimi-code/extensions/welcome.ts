// 代码型扩展示例：启动 TUI 时自动加载
// 试试：在 TUI 里输入 /welcome:hello  会触发命令
//      让模型调用 echo 工具
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI): void => {
  // 注册一个工具：模型可以调用它
  api.registerTool({
    name: 'echo',
    description: '原样返回输入文本。可用来测试扩展工具是否生效。',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '要原样返回的文本' } },
      required: ['message'],
    },
    async execute({ args }) {
      return { output: `[echo 扩展工具] ${args['message'] ?? ''}` };
    },
  });

  // 注册一个斜杠命令：/welcome:hello
  api.registerCommand('hello', {
    description: '欢迎命令 — 验证扩展加载',
    prompt: (args) => `请简短打个招呼${args ? `，并提到「${args}」` : ''}。`,
  });

  // 订阅事件：每次工具调用后打印（会显示在 stderr，可在日志看到）
  api.on('tool_result', (event) => {
    console.error(`[welcome 扩展] 工具调用完成: ${event.toolName} (${event.isError ? '失败' : '成功'})`);
  });
};
