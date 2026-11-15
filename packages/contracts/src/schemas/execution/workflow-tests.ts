import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import { boundedNodeTestJsonInputSchema } from '../shared/bounded-json-input.js';
import { workflowRunStatusSchema } from './runs.js';
import { workflowGraphStructuralSchema } from '@pertexo/workflow-model';

const WORKFLOW_TESTS_BOUNDS = Object.freeze({
  nodeIdCharacters: 256,
  samplesItems: 200,
  labelCharacters: 256,
  effectfulStepsItems: 200,
  expectedSamplesItems: 200,
  expectedEffectfulStepsItemCharacters: 256,
  expectedEffectfulStepsItems: 200,
  workflowTestListPageItems: 20,
  dispositionsCharacters: 256,
});

const sampleSchema = z
  .object({
    nodeId: z.string().min(1).max(WORKFLOW_TESTS_BOUNDS.nodeIdCharacters),
    sampleId: z.uuid(),
  })
  .strict();
export const workflowTestPreparationSchema = responseSchema(
  z
    .object({
      draftRevision: z.number().int().positive(),
      samples: z.array(sampleSchema).max(WORKFLOW_TESTS_BOUNDS.samplesItems),
      effectfulSteps: z
        .array(
          z
            .object({
              nodeId: z
                .string()
                .min(1)
                .max(WORKFLOW_TESTS_BOUNDS.nodeIdCharacters),
              label: z.string().max(WORKFLOW_TESTS_BOUNDS.labelCharacters),
            })
            .strict(),
        )
        .max(WORKFLOW_TESTS_BOUNDS.effectfulStepsItems),
    })
    .strict(),
);
export const workflowTestStartRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    expectedSamples: z
      .array(sampleSchema)
      .max(WORKFLOW_TESTS_BOUNDS.expectedSamplesItems),
    expectedEffectfulSteps: z
      .array(
        z
          .string()
          .min(1)
          .max(WORKFLOW_TESTS_BOUNDS.expectedEffectfulStepsItemCharacters),
      )
      .max(WORKFLOW_TESTS_BOUNDS.expectedEffectfulStepsItems),
    input: boundedNodeTestJsonInputSchema,
    acknowledgeSideEffects: z.boolean(),
  })
  .strict();
export const workflowTestAcceptedSchema = responseSchema(
  z.object({ runId: z.uuid() }).strict(),
);
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
export const workflowTestListSchema = responseSchema(
  z
    .object({
      items: z
        .array(summarySchema)
        .max(WORKFLOW_TESTS_BOUNDS.workflowTestListPageItems),
    })
    .strict(),
);
export const workflowTestDetailSchema = responseSchema(
  summarySchema
    .extend({
      graph: workflowGraphStructuralSchema,
      dispositions: z.record(
        z.string().min(1).max(WORKFLOW_TESTS_BOUNDS.dispositionsCharacters),
        z.enum([
          'pinned',
          'wait_skipped',
          'response_skipped',
          'pin_required',
          'execute',
        ]),
      ),
    })
    .strict(),
);
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
export const workflowTestCancelResponseSchema = responseSchema(
  z.object({ canceled: z.literal(true) }).strict(),
);
