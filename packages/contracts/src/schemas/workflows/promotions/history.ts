import { z } from 'zod';
import {
  PROMOTION_LIMITS,
  promotionIdentifierSchema as id,
} from './settings.js';
import { workflowPromotionModeSchema } from './review.js';

export const workflowPromotionPageQuerySchema = z
  .object({
    after: id.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PROMOTION_LIMITS.page)
      .default(20),
    search: z.string().trim().max(128).optional(),
  })
  .strict();
export const workflowPromotionCandidatesQuerySchema =
  workflowPromotionPageQuerySchema
    .extend({
      workflowId: id.optional(),
      beforeVersionNumber: z.coerce
        .number()
        .int()
        .positive()
        .max(2147483647)
        .optional(),
    })
    .strict()
    .refine(
      (query) =>
        query.beforeVersionNumber === undefined ||
        query.workflowId !== undefined,
      'Choose a workflow when paging its versions.',
    )
    .refine(
      (query) =>
        query.workflowId === undefined ||
        (query.after === undefined && query.search === undefined),
      'Use a version cursor when listing a workflow’s retained versions.',
    );
export type WorkflowPromotionCandidatesQuery = z.output<
  typeof workflowPromotionCandidatesQuerySchema
>;
export const workflowPromotionCandidatesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            workflowId: id,
            name: z.string().max(128),
            versionId: id,
            versionNumber: z.number().int().positive(),
          })
          .strict(),
      )
      .max(PROMOTION_LIMITS.page),
    nextCursor: id.nullable(),
    nextVersionNumber: z.number().int().positive().nullable(),
  })
  .strict();
export const workflowPromotionHistorySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id,
            promotionId: id,
            occurredAt: z.iso.datetime(),
            actorId: id.nullable(),
            actorName: z.string().max(256),
            workflowId: id,
            workflowName: z.string().max(128),
            sourceWorkspaceId: id,
            sourceWorkflowId: id,
            sourceVersionId: id,
            targetWorkspaceId: id,
            targetWorkflowId: id,
            targetVersionId: id.nullable(),
            publicationRequestId: id.nullable(),
            mode: workflowPromotionModeSchema,
          })
          .strict(),
      )
      .max(PROMOTION_LIMITS.page),
    nextCursor: id.nullable(),
  })
  .strict();
export type WorkflowPromotionPageQuery = z.output<
  typeof workflowPromotionPageQuerySchema
>;
export type WorkflowPromotionCandidates = z.output<
  typeof workflowPromotionCandidatesSchema
>;
export type WorkflowPromotionHistory = z.output<
  typeof workflowPromotionHistorySchema
>;
