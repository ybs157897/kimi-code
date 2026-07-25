/**
 * Example extension: show a non-blocking TUI status line when a turn ends.
 *
 * Prefer `ctx.notify` for tips — it does not start a new turn, change
 * streaming state, or enter model context. Do not use `sendUserMessage` for
 * end-of-turn tips (that would re-prompt the model).
 */
import type { ExtensionAPI } from '@moonshot-ai/agent-core/extension';

export default (api: ExtensionAPI): void => {
  api.on('turn_end', (_event, ctx) => {
    ctx.notify('Turn ended');
  });
};
