/**
 * `sessionExpertTeamService` — expert-team mode discovery, activation, and
 * live runtime snapshot contract.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const expertTeamMemberStatusSchema = z.enum([
  'spawning',
  'running',
  'completed',
  'failed',
  'shutdown',
]);

export const expertTeamPreviousProfileSchema = z.object({
  profileName: z.string().optional(),
  modelAlias: z.string().optional(),
  thinkingLevel: z.string(),
  cwd: z.string(),
  systemPrompt: z.string(),
  activeToolNames: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  subagents: z.array(z.string()).optional(),
});

export const expertTeamBindingSchema = z.object({
  pluginId: z.string(),
  pluginVersion: z.string().optional(),
  displayName: z.string(),
  leadAgentName: z.string(),
  leadProfileName: z.string(),
  memberAgentNames: z.array(z.string()),
  previousProfile: expertTeamPreviousProfileSchema,
  activatedAt: z.string(),
});

export const expertTeamMemberSchema = z.object({
  name: z.string(),
  agentId: z.string(),
  profileName: z.string(),
  status: expertTeamMemberStatusSchema,
  updatedAt: z.string(),
  taskId: z.string().optional(),
});

export const expertTeamRuntimeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  members: z.array(expertTeamMemberSchema),
});

const localizedTextSchema = z.union([z.string(), z.record(z.string(), z.string())]);

export const expertTeamSnapshotSchema = z.object({
  binding: expertTeamBindingSchema,
  team: expertTeamRuntimeSchema.optional(),
});

export const expertTeamDefinitionSchema = z.object({
  pluginId: z.string(),
  pluginVersion: z.string().optional(),
  displayName: z.string(),
  description: z.string().optional(),
  profession: z.string().optional(),
  tags: z.array(z.string()),
  leadAgentName: z.string(),
  memberAgentNames: z.array(z.string()),
  members: z.array(
    z.object({
      agent: z.string(),
      role: z.enum(['lead', 'member']),
      displayName: z.string().optional(),
      name: localizedTextSchema.optional(),
      profession: localizedTextSchema.optional(),
      description: z.string().optional(),
      avatar: z.string().optional(),
    }),
  ),
  quickPrompts: z.array(z.string()),
  defaultInitPrompt: z.string().optional(),
  categoryId: z.string().optional(),
});

export const sessionExpertTeamContract = {
  listAvailable: {
    input: z.tuple([]),
    output: z.array(expertTeamDefinitionSchema),
  },
  snapshot: {
    input: z.tuple([]),
    output: z.union([expertTeamSnapshotSchema, z.null()]),
  },
  activate: {
    input: z.tuple([z.string()]),
    output: expertTeamSnapshotSchema,
  },
  deactivate: {
    input: z.tuple([]),
    output: noResult,
  },
} satisfies ServiceContract;
