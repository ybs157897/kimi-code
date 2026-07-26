/**
 * SendMessageTool — the expert-team mailbox front door.
 *
 * A collaboration tool (like AgentTool) available only while an expert team is
 * active: it is gated on the agent's injected `teamMessenger` handle, so a
 * normal session never sees it. Every call forwards to `TeamMessenger.send`,
 * which renders the message as a `<teammate-message>` and delivers it in
 * process (steer onto the recipient's turn, or wake an idle member).
 *
 * Validation failures come back as `{ ok: false }` and surface as an error
 * ToolResult; nothing here throws for bad input.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { ToolAccesses } from '../../../loop/tool-access';
import type { TeamMessenger } from '../../../expert-team/runtime';
import { toInputJsonSchema } from '../../support/input-schema';
import SEND_MESSAGE_DESCRIPTION from './send-message.md?raw';

export const SendMessageToolInputSchema = z.object({
  type: z
    .enum(['message', 'broadcast', 'shutdown_request', 'shutdown_response'])
    .describe(
      'message: direct message to one teammate; broadcast: to every teammate except yourself; shutdown_request/shutdown_response: team shutdown handshake.',
    ),
  recipient: z
    .string()
    .optional()
    .describe(
      'Target teammate name. Required for type=message and shutdown_request. Use "team-lead" to reach the lead.',
    ),
  summary: z.string().describe('One-line summary shown in the teammate-message header.'),
  message: z
    .string()
    .optional()
    .describe('Full message body. Required for message and broadcast.'),
  request_id: z
    .string()
    .optional()
    .describe('Required for shutdown_response: the id from the shutdown_request you received.'),
  approve: z.boolean().optional().describe('Required for shutdown_response.'),
});

export type SendMessageToolInput = z.infer<typeof SendMessageToolInputSchema>;

export class SendMessageTool implements BuiltinTool<SendMessageToolInput> {
  readonly name = 'SendMessage';
  readonly description = SEND_MESSAGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendMessageToolInputSchema);

  constructor(
    private readonly messenger: TeamMessenger,
    private readonly selfName: string,
  ) {}

  resolveExecution(args: SendMessageToolInput): ToolExecution {
    const recipient = args.type === 'broadcast' ? 'all teammates' : args.recipient ?? '(unspecified)';
    return {
      description: `SendMessage ${args.type} → ${recipient}`,
      accesses: ToolAccesses.none(),
      display: { kind: 'generic', summary: `SendMessage ${args.type} → ${recipient}` },
      approvalRule: this.name,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SendMessageToolInput): Promise<ExecutableToolResult> {
    const result = await this.messenger.send({
      type: args.type,
      from: this.selfName,
      recipient: args.recipient,
      summary: args.summary,
      text: args.message,
      requestId: args.request_id,
      approve: args.approve,
    });
    return result.ok
      ? { output: result.message }
      : { output: result.message, isError: true };
  }
}
