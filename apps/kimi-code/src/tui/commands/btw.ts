import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { TUISessionRuntime } from '../runtime/tui-session-runtime';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleBtwCommand(host: SlashCommandHost, args: string): Promise<void> {
  const prompt = args.trim();
  const sessionId = host.state.appState.sessionId;
  if (host.state.appState.model.trim().length === 0 || sessionId.length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  let runtime: TUISessionRuntime;
  try {
    runtime = host.requireSessionRuntime();
  } catch {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  if (runtime.sessionId !== sessionId) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  host.btwPanelController.closeOrCancel();

  try {
    const agentId = await runtime.btw.start();
    host.btwPanelController.open(agentId, prompt);
  } catch (error) {
    host.showError(`Failed to start /btw: ${formatErrorMessage(error)}`);
  }
}
