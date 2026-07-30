/**
 * 每轮对话（turn）结束时在 TUI 状态行提示「会话结束」。
 *
 * 订阅 `turn_end`：模型完成本轮回复（含工具调用）后触发。
 * 使用 `ctx.notify`：只画状态行，不触发新一轮对话，也不改 streaming 状态。
 * 编辑后在 TUI 执行 `/reload` 即可生效。
 */
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI): void => {
  api.on('turn_end', (_event, ctx) => {
    ctx.notify('会话结束');
  });
};
