import { z } from 'zod';

/** A page of workflows: its opaque cursor and how many workflows it holds. */
export const WORKFLOW_PAGE_LIMITS = Object.freeze({
  cursorCharacters: 512,
  items: 100,
});

export const workflowCursorSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_PAGE_LIMITS.cursorCharacters);

const workflowPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(WORKFLOW_PAGE_LIMITS.items);

const workflowListOrderSchema = z.enum(['created_asc', 'updated_desc']);

export const workflowDraftQuerySchema = z
  .object({ include: z.literal('graphDigest').optional() })
  .strict();

export const workflowListQuerySchema = z
  .object({
    limit: workflowPageLimitSchema.optional(),
    after: workflowCursorSchema.optional(),
    order: workflowListOrderSchema.optional(),
    pinsWorkflowId: z.uuid().optional(),
    include: z.literal('listSummary').optional(),
  })
  .strict();

/** The opt-in additions to a version: older clients decode the default. */
export const workflowVersionsIncludeSchema = z.enum([
  'graphDigest',
  'publishedBy',
  'graphDigest,publishedBy',
]);

export const workflowVersionsQuerySchema = z
  .object({
    include: workflowVersionsIncludeSchema.optional(),
    limit: workflowPageLimitSchema.optional(),
    after: workflowCursorSchema.optional(),
    versionId: z
      .uuid()
      .describe(
        'Read one exact immutable version; cannot be combined with after.',
      )
      .optional(),
  })
  .strict()
  .refine(
    (query) => query.versionId === undefined || query.after === undefined,
    {
      message: 'An exact version lookup cannot use a history cursor.',
      path: ['after'],
    },
  );
