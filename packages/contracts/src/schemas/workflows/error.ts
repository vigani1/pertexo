import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';

export const workflowErrorSettingsSchema = responseSchema(
  z
    .object({
      targetWorkflowId: z.uuid().nullable(),
      targetWorkflowName: z.string().max(128).nullable().optional(),
      revision: z.number().int().positive().max(2_147_483_647),
    })
    .strict(),
);
export const workflowErrorSettingsRequestSchema = workflowErrorSettingsSchema
  .omit({ revision: true, targetWorkflowName: true })
  .extend({ expectedRevision: z.number().int().positive().max(2_147_483_647) })
  .strict();
export const workflowErrorSettingsResponseSchema = responseSchema(
  z
    .object({ settings: workflowErrorSettingsSchema, replayed: z.boolean() })
    .strict(),
);
export type WorkflowErrorSettings = z.infer<typeof workflowErrorSettingsSchema>;
export type WorkflowErrorSettingsRequest = z.infer<
  typeof workflowErrorSettingsRequestSchema
>;

export const workflowErrorTargetsQuerySchema = z
  .object({ after: z.uuid().optional() })
  .strict();
export const workflowErrorTargetsPageSchema = responseSchema(
  z
    .object({
      items: z
        .array(
          z.object({ id: z.uuid(), name: z.string().min(1).max(128) }).strict(),
        )
        .max(50),
      nextCursor: z.uuid().nullable(),
    })
    .strict(),
);
export type WorkflowErrorTargetsPage = z.infer<
  typeof workflowErrorTargetsPageSchema
>;
