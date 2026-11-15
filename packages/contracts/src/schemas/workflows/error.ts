import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import { STORED_INTEGER_MAX } from '@pertexo/workflow-model';

const ERROR_BOUNDS = Object.freeze({
  targetWorkflowNameCharacters: RESOURCE_NAME_MAX_LENGTH,
  nameCharacters: 128,
  workflowErrorTargetsPageItems: 50,
});

export const workflowErrorSettingsSchema = responseSchema(
  z
    .object({
      targetWorkflowId: z.uuid().nullable(),
      targetWorkflowName: z
        .string()
        .max(ERROR_BOUNDS.targetWorkflowNameCharacters)
        .nullable()
        .optional(),
      revision: z.number().int().positive().max(STORED_INTEGER_MAX),
    })
    .strict(),
);
export const workflowErrorSettingsRequestSchema = workflowErrorSettingsSchema
  .omit({ revision: true, targetWorkflowName: true })
  .extend({
    expectedRevision: z.number().int().positive().max(STORED_INTEGER_MAX),
  })
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
          z
            .object({
              id: z.uuid(),
              name: z.string().min(1).max(ERROR_BOUNDS.nameCharacters),
            })
            .strict(),
        )
        .max(ERROR_BOUNDS.workflowErrorTargetsPageItems),
      nextCursor: z.uuid().nullable(),
    })
    .strict(),
);
export type WorkflowErrorTargetsPage = z.infer<
  typeof workflowErrorTargetsPageSchema
>;
