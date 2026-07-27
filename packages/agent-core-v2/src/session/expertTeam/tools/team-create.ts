/**
 * `expertTeam` domain (L6) — `TeamCreate` lead-only tool.
 *
 * Creates the runtime team after an expert plugin has been activated. The
 * Session service validates role, mode, name, and single-team invariants.
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

export const TeamCreateInputSchema = z.object({
  team_name: z
    .string()
    .describe('Stable lowercase team id using letters, digits, "-" or "_".'),
  description: z.string().optional().describe('Short description of the team objective.'),
});

export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export interface ITeamCreateTool extends AgentTool<TeamCreateInput> {
  readonly _serviceBrand: undefined;
}
export const ITeamCreateTool = createDecorator<ITeamCreateTool>('expertTeamCreateTool');

export class TeamCreateTool implements ITeamCreateTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamCreate';
  readonly description =
    'Create the active expert team before spawning any declared specialists. Only the team lead may call this tool.';
  readonly parameters = toInputJsonSchema(TeamCreateInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ISessionExpertTeamService private readonly expertTeam: ISessionExpertTeamService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: TeamCreateInput): ToolExecution {
    return {
      description: `Creating expert team: ${args.team_name}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        try {
          const team = this.expertTeam.createTeam(this.callerAgentId, {
            name: args.team_name,
            description: args.description,
          });
          return {
            output: [
              '<expert_team_created>',
              `team_id: ${team.id}`,
              `name: ${team.name}`,
              `created_at: ${team.createdAt}`,
              '</expert_team_created>',
            ].join('\n'),
          };
        } catch (error) {
          return { output: errorMessage(error), isError: true };
        }
      },
    };
  }
}

registerAgentToolService(ITeamCreateTool, TeamCreateTool, {
  name: 'TeamCreate',
  domain: 'expertTeam',
  when: (accessor) => accessor.get(IFlagService).enabled(EXPERT_TEAMS_FLAG_ID),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
