import { z } from 'zod';

import { apiProblemIssueSchema } from '../errors/api-problem.js';

export const NODE_TEST_LIMITS_V1 = Object.freeze({
  validationIssues: 100,
  nodeIdLength: 256,
  safeErrorCodeLength: 128,
});

export const nodeTestParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    nodeId: z.string().min(1).max(NODE_TEST_LIMITS_V1.nodeIdLength),
  })
  .strict();

export const previewRunParamsSchema = z
  .object({ workspaceId: z.uuid(), previewRunId: z.uuid() })
  .strict();

export const nodeSideEffectClassSchema = z.enum([
  'safe',
  'idempotent_with_key',
  'unsafe',
]);

export const nodeSideEffectDisclosureSchema = z
  .object({
    sideEffectClass: nodeSideEffectClassSchema,
    mayContactProvider: z.boolean(),
    mayCauseExternalSideEffect: z.boolean(),
    dryRun: z.enum(['not_supported', 'provider_supported']),
  })
  .strict();

export const nodeTestInputSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), value: z.json() }).strict(),
  z
    .object({
      kind: z.literal('prior_preview'),
      previewRunId: z.uuid(),
    })
    .strict(),
]);

export const nodeValidateRequestSchema = z
  .object({
    mode: z.literal('validate'),
    expectedRevision: z.number().int().positive(),
    sampleInput: z.json().optional(),
  })
  .strict();

export const nodeTestExecuteRequestSchema = z
  .object({
    mode: z.literal('test_execute'),
    expectedRevision: z.number().int().positive(),
    input: nodeTestInputSourceSchema,
    acknowledgeSideEffects: z.literal(true),
  })
  .strict();

export const nodeTestRequestSchema = z.discriminatedUnion('mode', [
  nodeValidateRequestSchema,
  nodeTestExecuteRequestSchema,
]);

export const nodeValidationResponseSchema = z
  .object({
    mode: z.literal('validate'),
    valid: z.boolean(),
    revision: z.number().int().positive(),
    nodeId: z.string().min(1).max(NODE_TEST_LIMITS_V1.nodeIdLength),
    issues: z
      .array(apiProblemIssueSchema)
      .max(NODE_TEST_LIMITS_V1.validationIssues),
    disclosure: nodeSideEffectDisclosureSchema,
  })
  .strict();

export const previewRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export const previewOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), value: z.json() }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.uuid() }).strict(),
]);

export const previewRunSummarySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    draftRevision: z.number().int().positive(),
    nodeId: z.string().min(1).max(NODE_TEST_LIMITS_V1.nodeIdLength),
    status: previewRunStatusSchema,
    disclosure: nodeSideEffectDisclosureSchema,
    output: previewOutputSchema.nullable(),
    safeErrorCode: z
      .string()
      .min(1)
      .max(NODE_TEST_LIMITS_V1.safeErrorCodeLength)
      .nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const nodeTestExecuteAcceptedResponseSchema = z
  .object({
    mode: z.literal('test_execute'),
    preview: previewRunSummarySchema,
    replayed: z.boolean(),
  })
  .strict();

export const previewRunResponseSchema = z
  .object({ preview: previewRunSummarySchema })
  .strict();

export type NodeTestRequest = z.output<typeof nodeTestRequestSchema>;
export type NodeValidationResponse = z.output<
  typeof nodeValidationResponseSchema
>;
export type PreviewRunSummary = z.output<typeof previewRunSummarySchema>;
export type NodeTestExecuteAcceptedResponse = z.output<
  typeof nodeTestExecuteAcceptedResponseSchema
>;
export type PreviewRunResponse = z.output<typeof previewRunResponseSchema>;
