/**
 * `expertTeam` domain (L6) — replayable expert-team Session state.
 *
 * The main Agent wire is the single durable journal for activation, team
 * creation, member state, and deletion. The Session service is a stateless
 * facade over this model.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type {
  ExpertTeamMember,
  ExpertTeamRuntime,
  ExpertTeamSnapshot,
} from './expertTeam';

const ExpertTeamMemberStatusSchema = z.enum([
  'spawning',
  'running',
  'completed',
  'failed',
  'shutdown',
]);

const ExpertTeamPreviousProfileSchema = z.object({
  profileName: z.string().optional(),
  modelAlias: z.string().optional(),
  thinkingLevel: z.string(),
  cwd: z.string(),
  systemPrompt: z.string(),
  activeToolNames: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  subagents: z.array(z.string()).optional(),
});

const ExpertTeamBindingSchema = z.object({
  pluginId: z.string(),
  pluginVersion: z.string().optional(),
  displayName: z.string(),
  leadAgentName: z.string(),
  leadProfileName: z.string(),
  memberAgentNames: z.array(z.string()),
  previousProfile: ExpertTeamPreviousProfileSchema,
  activatedAt: z.string(),
});

const ExpertTeamMemberSchema: z.ZodType<ExpertTeamMember> = z.object({
  name: z.string(),
  agentId: z.string(),
  profileName: z.string(),
  status: ExpertTeamMemberStatusSchema,
  updatedAt: z.string(),
  taskId: z.string().optional(),
});

const ExpertTeamRuntimeSchema: z.ZodType<ExpertTeamRuntime> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  members: z.array(ExpertTeamMemberSchema),
});

const ExpertTeamSnapshotSchema: z.ZodType<ExpertTeamSnapshot> = z.object({
  binding: ExpertTeamBindingSchema,
  team: ExpertTeamRuntimeSchema.optional(),
});

export const ExpertTeamModel = defineModel<ExpertTeamSnapshot | null>(
  'expertTeam',
  () => null,
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'expert_team.activate': typeof expertTeamActivate;
    'expert_team.deactivate': typeof expertTeamDeactivate;
    'expert_team.create': typeof expertTeamCreate;
    'expert_team.member_upsert': typeof expertTeamMemberUpsert;
    'expert_team.delete': typeof expertTeamDelete;
  }
}

export const expertTeamActivate = ExpertTeamModel.defineOp('expert_team.activate', {
  schema: z.object({ snapshot: ExpertTeamSnapshotSchema }),
  apply: (_state, payload) => payload.snapshot,
});

export const expertTeamDeactivate = ExpertTeamModel.defineOp('expert_team.deactivate', {
  schema: z.object({}),
  apply: () => null,
});

export const expertTeamCreate = ExpertTeamModel.defineOp('expert_team.create', {
  schema: z.object({ team: ExpertTeamRuntimeSchema }),
  apply: (state, payload) => (state === null ? state : { ...state, team: payload.team }),
});

export const expertTeamMemberUpsert = ExpertTeamModel.defineOp('expert_team.member_upsert', {
  schema: z.object({ member: ExpertTeamMemberSchema }),
  apply: (state, payload) => {
    if (state?.team === undefined) return state;
    const members = state.team.members.filter((member) => member.agentId !== payload.member.agentId);
    return {
      ...state,
      team: {
        ...state.team,
        members: [...members, payload.member],
      },
    };
  },
});

export const expertTeamDelete = ExpertTeamModel.defineOp('expert_team.delete', {
  schema: z.object({}),
  apply: (state) => (state === null ? null : { binding: state.binding }),
});
