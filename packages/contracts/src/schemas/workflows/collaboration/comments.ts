import { responseSchema } from '../../shared/response-schema.js';
import {
  COLLABORATION_LIMITS,
  DISPLAY_NAME_MAX_CHARACTERS,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
} from '@pertexo/workflow-model';
export { COLLABORATION_LIMITS };
import { z } from 'zod';
import { isStorageText } from '@pertexo/workflow-model';
import { STORED_INTEGER_MAX } from '@pertexo/workflow-model';

const COMMENTS_BOUNDS = Object.freeze({
  workflowCommentStepIdCharacters:
    WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength,
  stepIdCharacters: WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength,
  stepLabelCharacters: 256,
  previewCharacters: 400,
  authorNameCharacters: DISPLAY_NAME_MAX_CHARACTERS,
  displayNameCharacters: DISPLAY_NAME_MAX_CHARACTERS,
});

const id = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(STORED_INTEGER_MAX);
export const workflowCommentStepIdSchema = z
  .string()
  .min(1)
  .max(COMMENTS_BOUNDS.workflowCommentStepIdCharacters)
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
      .default(COLLABORATION_LIMITS.page),
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
    stepId: z.string().max(COMMENTS_BOUNDS.stepIdCharacters).nullable(),
    stepLabel: z.string().max(COMMENTS_BOUNDS.stepLabelCharacters).nullable(),
    status: z.enum(['open', 'resolved']),
    revision,
    createdBy: id.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    commentCount: z.number().int().nonnegative(),
    preview: z.string().max(COMMENTS_BOUNDS.previewCharacters).nullable(),
  })
  .strict();
export const workflowCommentSchema = z
  .object({
    id,
    threadId: id,
    authorId: id.nullable(),
    authorName: z.string().max(COMMENTS_BOUNDS.authorNameCharacters),
    body: z.string().max(COLLABORATION_LIMITS.body),
    revision,
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    mentions: z
      .array(
        z
          .object({
            userId: id,
            displayName: z.string().max(COMMENTS_BOUNDS.displayNameCharacters),
          })
          .strict(),
      )
      .max(COLLABORATION_LIMITS.mentions),
  })
  .strict();
export const workflowCommentListSchema = responseSchema(
  z
    .object({
      items: z
        .array(workflowCommentThreadSchema)
        .max(COLLABORATION_LIMITS.page),
      nextCursor: id.nullable(),
    })
    .strict(),
);
export const workflowCommentDetailSchema = responseSchema(
  z
    .object({
      thread: workflowCommentThreadSchema,
      comments: z.array(workflowCommentSchema).max(COLLABORATION_LIMITS.page),
      nextCursor: id.nullable(),
    })
    .strict(),
);
export const workflowCommentCommandResultSchema = responseSchema(
  z
    .object({
      threadId: id,
      commentId: id.nullable(),
      revision,
      replayed: z.boolean(),
      deleted: z.boolean(),
      threadDeleted: z.boolean(),
    })
    .strict(),
);
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
