import { z } from 'zod';

import { canonicalWorkflowPortableJson } from '@pertexo/workflow-model';

const originFields = {
  schemaVersion: z.literal(1),
  templateId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  templateVersion: z.number().int().min(1).max(2_147_483_647),
  baseManifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
};

export const workflowTemplateOriginRequestSchema = z
  .object(originFields)
  .strict();
export const workflowTemplateOriginSchema = z
  .object({
    ...originFields,
    creationCommandDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    derivation: z.enum(['direct', 'inherited']),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(canonicalWorkflowPortableJson(value))
        .byteLength <= 512,
  );

export type WorkflowTemplateOriginRequest = z.infer<
  typeof workflowTemplateOriginRequestSchema
>;
export type WorkflowTemplateOrigin = z.infer<
  typeof workflowTemplateOriginSchema
>;
