import { z } from 'zod';
import { createApiProblemSchema } from '../errors/api-problem.js';

export const workflowConcurrencyRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647);
export const workflowConcurrencyLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(10_000);
export const workflowConcurrencySettingsSchema = z
  .object({
    asOf: z.iso.datetime({ precision: 6 }),
    limit: workflowConcurrencyLimitSchema.nullable(),
    revision: workflowConcurrencyRevisionSchema,
    workspaceActiveRunLimit: workflowConcurrencyLimitSchema.nullable(),
    workspacePolicyState: z.enum([
      'active',
      'suspended',
      'not_yet_effective',
      'expired',
      'unavailable',
    ]),
    overflow: z.literal('queue'),
  })
  .strict();
export const workflowConcurrencySettingsRequestSchema = z
  .object({
    limit: workflowConcurrencyLimitSchema.nullable(),
    expectedRevision: workflowConcurrencyRevisionSchema,
  })
  .strict();
export const workflowConcurrencyCommandResponseSchema = z
  .object({
    settings: workflowConcurrencySettingsSchema,
    replayed: z.boolean(),
  })
  .strict();
export const workflowConcurrencyRevisionConflictProblemSchema =
  createApiProblemSchema({
    status: z.literal(409),
    code: z.literal('workflow.concurrency_revision_conflict'),
    currentRevision: workflowConcurrencyRevisionSchema,
  });
export const workflowConcurrencyLimitExceededProblemSchema =
  createApiProblemSchema({
    status: z.literal(409),
    code: z.literal('workflow.concurrency_limit_exceeded'),
    maximum: workflowConcurrencyLimitSchema,
  });
export type WorkflowConcurrencySettings = z.output<
  typeof workflowConcurrencySettingsSchema
>;
export type WorkflowConcurrencySettingsRequest = z.output<
  typeof workflowConcurrencySettingsRequestSchema
>;
export type WorkflowConcurrencyCommandResponse = z.output<
  typeof workflowConcurrencyCommandResponseSchema
>;
