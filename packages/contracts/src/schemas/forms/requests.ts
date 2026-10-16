import { z } from 'zod';
import {
  formConfigSchema,
  formThankYouMessageSchema,
} from '@pertexo/workflow-model';
export const formParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid() })
  .strict();
export const publicFormParamsSchema = z.object({ publicId: z.uuid() }).strict();
export const formCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const formSchemaResponseSchema = z
  .object({
    versionId: z.uuid(),
    form: formConfigSchema.omit({ thankYouMessage: true }),
  })
  .strict();
export const formSubmissionRequestSchema = z
  .object({ versionId: z.uuid(), values: z.record(z.string(), z.unknown()) })
  .strict();
export const formSubmissionResponseSchema = z
  .object({
    accepted: z.literal(true),
    thankYouMessage: formThankYouMessageSchema,
    runId: z.uuid().optional(),
    replayed: z.boolean(),
  })
  .strict();
export const formAccessSchema = z
  .object({
    access: z.enum(['members', 'public']),
    publicId: z.uuid().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const formAccessRequestSchema = z.discriminatedUnion('access', [
  z
    .object({
      access: z.literal('members'),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      access: z.literal('public'),
      expectedRevision: z.number().int().nonnegative(),
      capability: formCapabilitySchema,
    })
    .strict(),
]);
export type FormSchemaResponse = z.output<typeof formSchemaResponseSchema>;
export type FormSubmissionRequest = z.output<
  typeof formSubmissionRequestSchema
>;
export type FormSubmissionResponse = z.output<
  typeof formSubmissionResponseSchema
>;
export type FormAccess = z.output<typeof formAccessSchema>;
export type FormAccessRequest = z.output<typeof formAccessRequestSchema>;
export const publicFormSubmissionResponseSchema = formSubmissionResponseSchema
  .omit({ runId: true })
  .strict();
