/**
 * `/api/v1` expert-team REST wire schemas.
 *
 * The engine owns camelCase domain state; this product boundary projects
 * stable snake_case HTTP payloads for discovery, activation, progress, and
 * exit.
 */

import { z } from 'zod';

export const expertTeamSessionParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const activateExpertTeamRequestSchema = z.object({
  plugin_id: z.string().min(1),
});

export const expertTeamMemberStatusSchema = z.enum([
  'spawning',
  'running',
  'completed',
  'failed',
  'shutdown',
]);

const localizedTextSchema = z.union([z.string(), z.record(z.string(), z.string())]);

export const expertTeamDefinitionSchema = z.object({
  plugin_id: z.string(),
  plugin_version: z.string().optional(),
  display_name: z.string(),
  description: z.string().optional(),
  profession: z.string().optional(),
  tags: z.array(z.string()),
  lead_agent_name: z.string(),
  member_agent_names: z.array(z.string()),
  members: z.array(
    z.object({
      agent: z.string(),
      role: z.enum(['lead', 'member']),
      display_name: z.string().optional(),
      name: localizedTextSchema.optional(),
      profession: localizedTextSchema.optional(),
      description: z.string().optional(),
      avatar: z.string().optional(),
    }),
  ),
  quick_prompts: z.array(z.string()),
  default_init_prompt: z.string().optional(),
  category_id: z.string().optional(),
});

export const expertTeamSnapshotSchema = z.object({
  binding: z.object({
    plugin_id: z.string(),
    plugin_version: z.string().optional(),
    display_name: z.string(),
    lead_agent_name: z.string(),
    lead_profile_name: z.string(),
    member_agent_names: z.array(z.string()),
    previous_profile_name: z.string().optional(),
    activated_at: z.string(),
  }),
  team: z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      created_at: z.string(),
      members: z.array(
        z.object({
          name: z.string(),
          agent_id: z.string(),
          profile_name: z.string(),
          status: expertTeamMemberStatusSchema,
          updated_at: z.string(),
          task_id: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export const listExpertTeamsResponseSchema = z.object({
  experts: z.array(expertTeamDefinitionSchema),
});

export const getExpertTeamResponseSchema = z.object({
  expert_team: z.union([expertTeamSnapshotSchema, z.null()]),
});

export const deactivateExpertTeamResponseSchema = z.object({
  deactivated: z.literal(true),
});
