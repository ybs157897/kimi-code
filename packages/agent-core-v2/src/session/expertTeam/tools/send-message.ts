/**
 * `expertTeam` domain (L6) — `SendMessage` expert-team channel.
 *
 * Delivers a typed message through the Session service. Runtime policy keeps
 * the topology lead-centered: the lead may address spawned members, and each
 * member may address only the lead.
 */

import { z } from 'zod';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';
import { EXPERT_TEAMS_FLAG_ID } from '#/app/plugin/types';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  type BuiltinTool,
  type ToolExecution,
  ToolAccesses,
} from '#/tool/toolContract';

import { ISessionExpertTeamService } from '../expertTeam';

export const SendMessageInputSchema = z.object({
  recipient: z
    .string()
    .describe('Spawned member name or agent id; members must use "team-lead" or "main".'),
  content: z.string().describe('Complete message content for the recipient.'),
  message_type: z
    .enum(['message', 'shutdown_request', 'shutdown_response'])
    .optional()
    .default('message')
    .describe('Normal collaboration message or the explicit shutdown handshake.'),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export class SendMessageTool implements BuiltinTool<SendMessageInput> {
  readonly name = 'SendMessage';
  readonly description =
    'Send an authoritative expert-team message. Members must send their complete findings to the lead; only the lead may send shutdown requests.';
  readonly parameters = toInputJsonSchema(SendMessageInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ISessionExpertTeamService private readonly expertTeam: ISessionExpertTeamService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: SendMessageInput): ToolExecution {
    return {
      description: `Sending expert-team message to ${args.recipient}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        try {
          const result = await this.expertTeam.sendMessage({
            callerAgentId: this.callerAgentId,
            recipient: args.recipient,
            content: args.content,
            messageType: args.message_type,
          });
          return {
            output: [
              '<expert_team_message_sent>',
              `recipient_agent_id: ${result.targetAgentId}`,
              result.turnId === undefined ? undefined : `turn_id: ${String(result.turnId)}`,
              '</expert_team_message_sent>',
            ]
              .filter((line): line is string => line !== undefined)
              .join('\n'),
          };
        } catch (error) {
          return { output: errorMessage(error), isError: true };
        }
      },
    };
  }
}

registerTool(SendMessageTool, {
  when: (accessor) => accessor.get(IFlagService).enabled(EXPERT_TEAMS_FLAG_ID),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
