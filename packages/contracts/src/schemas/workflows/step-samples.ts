import { z } from 'zod';
import { boundedNodeTestJsonInputSchema } from '../shared/bounded-json-input.js';

export const stepSampleSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('json'), value: boundedNodeTestJsonInputSchema })
    .strict(),
  z.object({ kind: z.literal('webhook_test'), listenerId: z.uuid() }).strict(),
  z.object({ kind: z.literal('preview'), previewRunId: z.uuid() }).strict(),
  z
    .object({ kind: z.literal('run'), runId: z.uuid(), nodeRunId: z.uuid() })
    .strict(),
  z.object({ kind: z.literal('confirm') }).strict(),
]);
export const stepSampleWriteRequestSchema = z
  .object({
    expectedDraftRevision: z.number().int().positive(),
    expectedSampleId: z.uuid().nullable(),
    source: stepSampleSourceSchema,
  })
  .strict();
export const stepSampleDeleteRequestSchema = z
  .object({
    expectedDraftRevision: z.number().int().positive(),
    expectedSampleId: z.uuid(),
  })
  .strict();
export const stepSampleMetadataSchema = z
  .object({
    id: z.uuid(),
    nodeId: z.string().min(1).max(64),
    binding: z.string(),
    state: z.enum(['pinned', 'stale', 'expired']),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('json') }).strict(),
      z.object({ kind: z.literal('webhook_test') }).strict(),
      z.object({ kind: z.literal('preview'), previewRunId: z.uuid() }).strict(),
      z
        .object({
          kind: z.literal('run'),
          runId: z.uuid(),
          nodeRunId: z.uuid(),
        })
        .strict(),
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const sampleLimitsSchema = z
  .object({
    inlineBytes: z.number().int().positive(),
    depth: z.number().int().positive(),
    members: z.number().int().positive(),
  })
  .strict();
export const stepSampleListResponseSchema = z
  .object({
    items: z.array(stepSampleMetadataSchema).max(200),
    draftRevision: z.number().int().positive(),
    limits: sampleLimitsSchema,
  })
  .strict();
export const stepSampleResponseSchema = z
  .object({
    sample: stepSampleMetadataSchema.nullable(),
    output: boundedNodeTestJsonInputSchema.nullable(),
    draftRevision: z.number().int().positive(),
    limits: sampleLimitsSchema,
  })
  .strict();
export const stepSampleCommandResponseSchema = z
  .object({ sampleId: z.uuid(), removed: z.boolean(), replayed: z.boolean() })
  .strict();
export type StepSampleMetadata = z.output<typeof stepSampleMetadataSchema>;
export type StepSampleResponse = z.output<typeof stepSampleResponseSchema>;
export type StepSampleListResponse = z.output<
  typeof stepSampleListResponseSchema
>;
export type StepSampleSource = z.output<typeof stepSampleSourceSchema>;
export type StepSampleWriteRequest = z.output<
  typeof stepSampleWriteRequestSchema
>;
export type StepSampleDeleteRequest = z.output<
  typeof stepSampleDeleteRequestSchema
>;
export type StepSampleCommandResponse = z.output<
  typeof stepSampleCommandResponseSchema
>;
