import { z } from 'zod';

export const PROMOTION_LIMITS = Object.freeze({
  workflows: 20,
  graphBytes: 2 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  requirements: 1000,
  page: 50,
});
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
