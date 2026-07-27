/**
 * `expertTeam` domain (L6) — `TeamDelete` lead-only tool.
 *
 * Deletes the active runtime roster after every member has stopped. Expert
 * mode remains bound until the outer product edge deactivates it.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';
import { EXPERT_TEAMS_FLAG_ID } from '#/app/plugin/types';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  type AgentTool,
  type ToolExecution,
  ToolAccesses,
} from '#/tool/toolContract';

import { ISessionExpertTeamService } from '../expertTeam';

export const TeamDeleteInputSchema = z.object({});

export type TeamDeleteInput = z.infer<typeof TeamDeleteInputSchema>;

export interface ITeamDeleteTool extends AgentTool<TeamDeleteInput> {
  readonly _serviceBrand: undefined;
}
export const ITeamDeleteTool = createDecorator<ITeamDeleteTool>('expertTeamDeleteTool');

export class TeamDeleteTool implements ITeamDeleteTool {
  declare readonly _serviceBrand: undefined;
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

registerAgentToolService(ITeamDeleteTool, TeamDeleteTool, {
  name: 'TeamDelete',
  domain: 'expertTeam',
  when: (accessor) => accessor.get(IFlagService).enabled(EXPERT_TEAMS_FLAG_ID),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
