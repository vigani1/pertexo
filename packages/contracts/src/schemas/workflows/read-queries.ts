import { z } from 'zod';

export const workflowCursorSchema = z.string().min(1).max(512);

const workflowPageLimitSchema = z.coerce.number().int().min(1).max(100);

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

export const workflowVersionsQuerySchema = z
  .object({
    include: z.literal('graphDigest').optional(),
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
