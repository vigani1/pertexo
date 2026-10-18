import { z } from 'zod';
import {
  PROMOTION_LIMITS,
  promotionIdentifierSchema as id,
} from './settings.js';
import { workflowPromotionPreviewRequestSchema } from './review.js';

export const workflowPromotionApplySchema =
  workflowPromotionPreviewRequestSchema
    .extend({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      acknowledgeTargetChanges: z
        .array(id)
        .max(PROMOTION_LIMITS.workflows)
        .default([])
        .refine(
          (ids) => new Set(ids).size === ids.length,
          'Acknowledge each workflow once.',
        ),
      note: z.string().trim().min(1).max(1000).optional(),
    })
    .strict();
export const workflowPromotionResultSchema = z
  .object({
    promotionId: id,
    sourceWorkspaceId: id,
    targetWorkspaceId: id,
    replayed: z.boolean(),
    items: z
      .array(
        z
          .object({
            sourceWorkflowId: id,
            targetWorkflowId: id,
            revision: z.number().int().positive(),
            publishedVersionId: id.nullable(),
            versionNumber: z.number().int().positive().nullable(),
            publicationRequestId: id.nullable(),
          })
          .strict(),
      )
      .max(PROMOTION_LIMITS.workflows),
  })
  .strict();
export type WorkflowPromotionApply = z.output<
  typeof workflowPromotionApplySchema
>;
export type WorkflowPromotionResult = z.output<
  typeof workflowPromotionResultSchema
>;
