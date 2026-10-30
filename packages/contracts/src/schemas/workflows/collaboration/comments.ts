import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
export { COLLABORATION_LIMITS };
import { z } from 'zod';
import { isStorageText } from '@pertexo/workflow-model';

const id = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(2147483647);
export const workflowCommentStepIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isStorageText);
export const workflowCommentBodySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(COLLABORATION_LIMITS.body)
      .refine(isStorageText, 'Use valid Unicode text without null characters.'),
    mentionUserIds: z
      .array(id)
      .max(COLLABORATION_LIMITS.mentions)
      .default([])
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Mention each person once.',
      ),
  })
  .strict();
export const workflowCommentCreateSchema = workflowCommentBodySchema
  .extend({
    stepId: workflowCommentStepIdSchema.nullable().default(null),
  })
  .strict();
export const workflowCommentEditSchema = workflowCommentBodySchema
  .extend({ expectedRevision: revision })
  .strict();
export const workflowCommentDeleteSchema = z
  .object({ expectedRevision: revision })
  .strict();
export const workflowCommentStatusSchema = z
  .object({ expectedRevision: revision, status: z.enum(['open', 'resolved']) })
  .strict();
export const workflowCommentListQuerySchema = z
  .object({
    after: id.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_LIMITS.page)
      .default(COLLABORATION_LIMITS.page),
    status: z.enum(['all', 'open', 'resolved']).default('open'),
    scope: z.enum(['all', 'workflow', 'step']).default('all'),
    stepId: workflowCommentStepIdSchema.optional(),
  })
  .strict()
  .refine(
    (query) => (query.scope === 'step') === (query.stepId !== undefined),
    'Choose a step only when filtering step discussions.',
  );
export const workflowCommentDetailQuerySchema = z
  .object({
    before: id.optional(),
    anchor: id.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(COLLABORATION_LIMITS.page)
      .default(20),
  })
  .strict()
  .refine(
    (query) => query.before === undefined || query.anchor === undefined,
    'Use one comment cursor.',
  );
export const workflowCommentThreadSchema = z
  .object({
    id,
    workflowId: id,
    stepId: z.string().max(128).nullable(),
    stepLabel: z.string().max(256).nullable(),
    status: z.enum(['open', 'resolved']),
    revision,
    createdBy: id.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    commentCount: z.number().int().nonnegative(),
    preview: z.string().max(400).nullable(),
  })
  .strict();
export const workflowCommentSchema = z
  .object({
    id,
    threadId: id,
    authorId: id.nullable(),
    authorName: z.string().max(256),
    body: z.string().max(COLLABORATION_LIMITS.body),
    revision,
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    mentions: z
      .array(
        z.object({ userId: id, displayName: z.string().max(256) }).strict(),
      )
      .max(COLLABORATION_LIMITS.mentions),
  })
  .strict();
export const workflowCommentListSchema = z
  .object({
    items: z.array(workflowCommentThreadSchema).max(COLLABORATION_LIMITS.page),
    nextCursor: id.nullable(),
  })
  .strict();
export const workflowCommentDetailSchema = z
  .object({
    thread: workflowCommentThreadSchema,
    comments: z.array(workflowCommentSchema).max(COLLABORATION_LIMITS.page),
    nextCursor: id.nullable(),
  })
  .strict();
export const workflowCommentCommandResultSchema = z
  .object({
    threadId: id,
    commentId: id.nullable(),
    revision,
    replayed: z.boolean(),
    deleted: z.boolean(),
    threadDeleted: z.boolean(),
  })
  .strict();
export type WorkflowCommentBody = z.output<typeof workflowCommentBodySchema>;
export type WorkflowCommentCreate = z.output<
  typeof workflowCommentCreateSchema
>;
export type WorkflowCommentEdit = z.output<typeof workflowCommentEditSchema>;
export type WorkflowCommentDelete = z.output<
  typeof workflowCommentDeleteSchema
>;
export type WorkflowCommentStatus = z.output<
  typeof workflowCommentStatusSchema
>;
export type WorkflowCommentListQuery = z.output<
  typeof workflowCommentListQuerySchema
>;
export type WorkflowCommentDetailQuery = z.output<
  typeof workflowCommentDetailQuerySchema
>;
export type WorkflowCommentThread = z.output<
  typeof workflowCommentThreadSchema
>;
export type WorkflowComment = z.output<typeof workflowCommentSchema>;
export type WorkflowCommentList = z.output<typeof workflowCommentListSchema>;
export type WorkflowCommentDetail = z.output<
  typeof workflowCommentDetailSchema
>;
export type WorkflowCommentCommandResult = z.output<
  typeof workflowCommentCommandResultSchema
>;
