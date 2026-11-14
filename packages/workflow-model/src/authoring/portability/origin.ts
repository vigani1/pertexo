import { z } from 'zod';

import { canonicalWorkflowPortableJson } from './portable-manifest.js';
import { utf8ByteLength } from '../../values/text.js';
import { STORED_INTEGER_MAX } from '../../values/stored-integer.js';

const TEMPLATE_ORIGIN_LIMITS = Object.freeze({
  templateIdLength: 64,
  originBytes: 512,
});

const originFields = {
  templateId: z
    .string()
    .min(1)
    .max(TEMPLATE_ORIGIN_LIMITS.templateIdLength)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  templateVersion: z.number().int().min(1).max(STORED_INTEGER_MAX),
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
      utf8ByteLength(canonicalWorkflowPortableJson(value)) <=
      TEMPLATE_ORIGIN_LIMITS.originBytes,
  );

export type WorkflowTemplateOriginRequest = z.infer<
  typeof workflowTemplateOriginRequestSchema
>;
export type WorkflowTemplateOrigin = z.infer<
  typeof workflowTemplateOriginSchema
>;
