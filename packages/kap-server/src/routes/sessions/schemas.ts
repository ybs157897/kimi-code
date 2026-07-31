/**
 * Request schemas for the `/sessions` routes: query coercions, path params,
 * the combined action body superset, and the shared validation `details`
 * schema.
 */

import { ErrorCode } from '../../protocol/error-codes';
import { workspaceIdSchema } from '../../protocol/workspace';
import { z } from 'zod';

export const booleanQueryParam = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === 1 || value === true) return true;
  if (value === 'false' || value === '0' || value === 0 || value === false) return false;
  return value;
}, z.boolean().optional());

export const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

// NOTE: mirrors v1's `GET /sessions` query. `before_id`/`after_id` id-cursors
// and `page_size` ARE applied in the route handler (the `FileSessionIndex` does
// not implement `cursor`, so we page over its recency-sorted result); `status`
// filters the projected page (post-page, matching v1). `include_archive` →
// `includeArchived`; `archived_only` forces `includeArchived` and then keeps
// only archived sessions; `workspace_id` → `workspaceIds` after
// `resolveAliasIds` expands the alias set of the directory (legacy split
// buckets list as one workspace); `exclude_empty` drops sessions with no
// prompt.
export const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    workspace_id: workspaceIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.archived_only === true && value.include_archive === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'archived_only and include_archive are mutually exclusive',
        path: ['archived_only'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

// Mirrors v1's children query: id-cursors + page_size + busy. The route
// projects the live busy fact onto each child and filters the page by it
// (post-page, matching v1); the child-marker filtering lives in
// `ISessionIndex.list({ childOf })`, the busy filter stays at the edge.
export const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

/**
 * Combined body schema for `POST /sessions/{tail}`. Each action parses its own
 * fields from this superset (mirrors v1's `sessionActionRequestSchema`, which is
 * also a server-side superset — the per-action wire schemas live in protocol).
 */
export const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string().optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);

export const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
