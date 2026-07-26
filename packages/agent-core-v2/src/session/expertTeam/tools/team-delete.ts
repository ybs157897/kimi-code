/**
 * `expertTeam` domain (L6) — `TeamDelete` lead-only tool.
 *
 * Deletes the active runtime roster after every member has stopped. Expert
 * mode remains bound until the outer product edge deactivates it.
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

export const TeamDeleteInputSchema = z.object({});

export type TeamDeleteInput = z.infer<typeof TeamDeleteInputSchema>;

export class TeamDeleteTool implements BuiltinTool<TeamDeleteInput> {
  readonly name = 'TeamDelete';
  readonly description =
    'Delete the active expert team after all members have completed or acknowledged shutdown. Fails while any member is active.';
  readonly parameters = toInputJsonSchema(TeamDeleteInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ISessionExpertTeamService private readonly expertTeam: ISessionExpertTeamService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(): ToolExecution {
    return {
      description: 'Deleting expert team',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        try {
          await this.expertTeam.deleteTeam(this.callerAgentId);
          return { output: '<expert_team_deleted />' };
        } catch (error) {
          return { output: errorMessage(error), isError: true };
        }
      },
    };
  }
}

registerTool(TeamDeleteTool, {
  when: (accessor) => accessor.get(IFlagService).enabled(EXPERT_TEAMS_FLAG_ID),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
