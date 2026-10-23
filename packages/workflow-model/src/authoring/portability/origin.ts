import { z } from 'zod';

import { canonicalWorkflowPortableJson } from './contract.js';
import { utf8ByteLength } from '../../values/text.js';

const originFields = {
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
    (value) => utf8ByteLength(canonicalWorkflowPortableJson(value)) <= 512,
  );

export type WorkflowTemplateOriginRequest = z.infer<
  typeof workflowTemplateOriginRequestSchema
>;
export type WorkflowTemplateOrigin = z.infer<
  typeof workflowTemplateOriginSchema
>;
