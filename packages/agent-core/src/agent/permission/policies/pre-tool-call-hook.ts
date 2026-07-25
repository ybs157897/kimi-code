import type { Agent } from '../..';
import { isPlainRecord } from '../../turn/canonical-args';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class PreToolCallHookPermissionPolicy implements PermissionPolicy {
  readonly name = 'pre-tool-call-hook';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const hookResult = await this.agent.hooks?.triggerBlock('PreToolUse', {
      matcherValue: context.toolCall.name,
      signal: context.signal,
      inputData: {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      },
    });
    context.signal.throwIfAborted();

    // Code-based extension `tool_call` event: runs alongside the declarative
    // PreToolUse hook. A handler returning { block: true } denies the call.
    const runner = this.agent.extensionRunner;
    if (runner?.hasHandlers('tool_call') === true) {
      const extResult = await runner.emit({
        type: 'tool_call',
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      });
      context.signal.throwIfAborted();
      if (extResult?.block === true) {
        return {
          kind: 'deny',
          message: extResult.reason ?? `Blocked by extension.`,
        };
      }
    }

    if (hookResult === undefined) return;
    return {
      kind: 'deny',
      message: hookResult.reason,
    };
  }
}
