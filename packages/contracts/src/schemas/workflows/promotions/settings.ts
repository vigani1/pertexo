import { PROMOTION_LIMITS } from '@pertexo/workflow-model';
export { PROMOTION_LIMITS };
import { z } from 'zod';

export const promotionIdentifierSchema = z
  .uuid()
  .overwrite((id) => id.toLowerCase());
export const workflowPromotionSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    canConfigure: z.boolean(),
    target: z
      .discriminatedUnion('status', [
        z
          .object({
            status: z.literal('available'),
            workspaceId: promotionIdentifierSchema,
            name: z.string().max(128),
            requireApproval: z.boolean(),
          })
          .strict(),
        z
          .object({
            status: z.literal('unavailable'),
            workspaceId: promotionIdentifierSchema,
            reason: z.string().max(512),
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict();
export const workflowPromotionTargetSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedTargetWorkspaceId: promotionIdentifierSchema.nullable(),
    targetWorkspaceId: promotionIdentifierSchema.nullable(),
  })
  .strict();
export type WorkflowPromotionSettings = z.output<
  typeof workflowPromotionSettingsSchema
>;
export type WorkflowPromotionTarget = z.output<
  typeof workflowPromotionTargetSchema
>;

export const workflowPromotionTargetResultSchema = z
  .object({
    replayed: z.boolean(),
    revision: z.number().int().positive(),
    targetWorkspaceId: promotionIdentifierSchema.nullable(),
  })
  .strict();
export type WorkflowPromotionTargetResult = z.output<
  typeof workflowPromotionTargetResultSchema
>;
