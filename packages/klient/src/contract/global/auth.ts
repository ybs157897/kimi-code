/**
 * `oauthService` + `authSummaryService` — app-scope OAuth flow and auth
 * summary. Mirrors `agent-core-v2/app/auth/auth.ts`; OAuth endpoint DTOs use
 * the protocol's snake_case fields, while `getManagedUsage` preserves the
 * service's camelCase `AuthManagedUsageResult`. `resolveTokenProvider` and
 * `getCachedAccessToken` are excluded (non-serializable).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const oAuthFlowStatusSchema = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);

export const oAuthFlowStartSchema = z.discriminatedUnion('status', [
  z.object({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('pending'),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    user_code: z.string(),
    expires_in: z.number(),
    interval: z.number(),
    expires_at: z.string(),
  }),
  z.object({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('authenticated'),
  }),
]);

export const oAuthFlowSnapshotSchema = z.object({
  flow_id: z.string(),
  provider: z.string(),
  status: oAuthFlowStatusSchema,
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  user_code: z.string(),
  expires_in: z.number(),
  expires_at: z.string(),
  interval: z.number(),
  resolved_at: z.string().optional(),
  error_message: z.string().optional(),
});

export const oAuthLoginCancelResponseSchema = z.object({
  cancelled: z.boolean(),
  status: oAuthFlowStatusSchema,
});

export const oAuthLogoutResponseSchema = z.object({
  logged_out: z.literal(true),
  provider: z.string(),
});

export const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  provider: z.string().optional(),
});

export const authManagedUsageRowSchema = z.object({
  label: z.string(),
  used: z.number().int(),
  limit: z.number().int(),
  resetHint: z.string().optional(),
});

export const authManagedUsageWalletSchema = z.object({
  balanceCents: z.number().int(),
  totalCents: z.number().int(),
  monthlyChargeLimitEnabled: z.boolean(),
  monthlyChargeLimitCents: z.number().int(),
  monthlyUsedCents: z.number().int(),
  currency: z.string(),
});

export const authManagedUsageResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    summary: authManagedUsageRowSchema.nullable(),
    limits: z.array(authManagedUsageRowSchema),
    extraUsage: authManagedUsageWalletSchema.nullable(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
    status: z.number().int().optional(),
  }),
]);

const managedFeedbackErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  status: z.number().int().optional(),
});

export const submitFeedbackBodySchema = z.object({
  session_id: z.string(),
  content: z.string(),
  version: z.string(),
  os: z.string(),
  model: z.string().nullable(),
  contact: z.string().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});

export const submitFeedbackResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    feedbackId: z.number().int(),
  }),
  managedFeedbackErrorSchema,
]);

export const createFeedbackUploadUrlBodySchema = z.object({
  file_hash: z.string(),
  file_name: z.string(),
  file_size: z.number().int(),
  feedback_id: z.number().int(),
});

export const feedbackUploadPartSchema = z.object({
  part_number: z.number().int(),
  url: z.string(),
  method: z.string(),
  size: z.number().int(),
});

export const createFeedbackUploadUrlResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    upload_id: z.number().int(),
    parts: z.array(feedbackUploadPartSchema),
  }),
  managedFeedbackErrorSchema,
]);

export const completeFeedbackUploadPartSchema = z.object({
  part_number: z.number().int(),
  etag: z.string(),
});

export const completeFeedbackUploadBodySchema = z.object({
  upload_id: z.number().int(),
  parts: z.array(completeFeedbackUploadPartSchema),
});

export const completeFeedbackUploadResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok') }),
  managedFeedbackErrorSchema,
]);

/** Same shape as `refreshProviderModelsResponseSchema` in `./catalog.js` — keep in sync. */
export const refreshOAuthProviderModelsResponseSchema = z.object({
  changed: z.array(
    z.object({
      provider_id: z.string(),
      provider_name: z.string(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), reason: z.string() })),
});

export const authContract = {
  startLogin: { input: z.tuple([z.string().optional()]), output: oAuthFlowStartSchema },
  getFlow: {
    input: z.tuple([z.string().optional()]),
    output: maybe(oAuthFlowSnapshotSchema),
  },
  cancelLogin: {
    input: z.tuple([z.string().optional()]),
    output: oAuthLoginCancelResponseSchema,
  },
  logout: { input: z.tuple([z.string().optional()]), output: oAuthLogoutResponseSchema },
  status: { input: z.tuple([z.string().optional()]), output: authStatusSchema },
  getManagedUsage: {
    input: z.tuple([z.string().optional()]),
    output: authManagedUsageResultSchema,
  },
  submitFeedback: {
    input: z.tuple([submitFeedbackBodySchema, z.string().optional()]),
    output: submitFeedbackResultSchema,
  },
  createFeedbackUploadUrl: {
    input: z.tuple([createFeedbackUploadUrlBodySchema, z.string().optional()]),
    output: createFeedbackUploadUrlResultSchema,
  },
  completeFeedbackUpload: {
    input: z.tuple([completeFeedbackUploadBodySchema, z.string().optional()]),
    output: completeFeedbackUploadResultSchema,
  },
  refreshOAuthProviderModels: {
    input: z.tuple([]),
    output: refreshOAuthProviderModelsResponseSchema,
  },
} satisfies ServiceContract;

export const authSummaryContract = {
  summarize: { input: z.tuple([]), output: z.array(authStatusSchema) },
  ensureReady: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;
