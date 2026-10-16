import { z } from 'zod';
import { boundedNodeTestJsonInputSchema } from '../shared/bounded-json-input.js';
import { workflowRunStatusSchema } from './runs.js';
import { workflowGraphStructuralSchema } from '@pertexo/workflow-model';

const sampleSchema = z
  .object({ nodeId: z.string().min(1).max(256), sampleId: z.uuid() })
  .strict();
export const workflowTestPreparationSchema = z
  .object({
    draftRevision: z.number().int().positive(),
    samples: z.array(sampleSchema).max(200),
    effectfulSteps: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(256),
            label: z.string().max(256),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const workflowTestStartRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    expectedSamples: z.array(sampleSchema).max(200),
    expectedEffectfulSteps: z.array(z.string().min(1).max(256)).max(200),
    input: boundedNodeTestJsonInputSchema,
    acknowledgeSideEffects: z.boolean(),
  })
  .strict();
export const workflowTestAcceptedSchema = z
  .object({ runId: z.uuid() })
  .strict();
const summarySchema = z
  .object({
    runId: z.uuid(),
    startedBy: z.uuid().nullable(),
    draftRevision: z.number().int().positive(),
    status: workflowRunStatusSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const workflowTestListSchema = z
  .object({ items: z.array(summarySchema).max(20) })
  .strict();
export const workflowTestDetailSchema = summarySchema
  .extend({
    graph: workflowGraphStructuralSchema,
    dispositions: z.record(
      z.string().min(1).max(256),
      z.enum([
        'pinned',
        'wait_skipped',
        'response_skipped',
        'pin_required',
        'execute',
      ]),
    ),
  })
  .strict();
export const workflowTestParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid(), runId: z.uuid() })
  .strict();
export type WorkflowTestPreparation = z.output<
  typeof workflowTestPreparationSchema
>;
export type WorkflowTestStartRequest = z.output<
  typeof workflowTestStartRequestSchema
>;

export const workflowTestCancelRequestSchema = z.object({}).strict();
export const workflowTestCancelResponseSchema = z
  .object({ canceled: z.literal(true) })
  .strict();
