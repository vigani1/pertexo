import { WORKFLOW_INPUT_CASE_LIMITS } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';
import {
  WORKFLOW_TEST_SUITE_MAX_CASES,
  workflowTestSuiteReportSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  workflowTestPreparationSchema,
  workflowTestStartRequestSchema,
} from './workflow-tests.js';

const TEST_SUITES_BOUNDS = Object.freeze({
  nameCharacters: WORKFLOW_INPUT_CASE_LIMITS.nameCharacters,
  stopReasonCharacters: 64,
  workflowTestSuiteListPageItems: 20,
  stepLabelsCharacters: 256,
  stepLabelsEntries: 20,
});
const caseIdentity = z
  .object({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();
export const workflowTestSuiteCurrentSchema = z
  .object({
    signature: z.string().regex(/^[0-9a-f]{64}$/u),
    draftRevision: z.number().int().positive(),
    variableSetRevision: z.number().int().positive().nullable(),
    samples: workflowTestPreparationSchema.shape.samples,
    cases: z
      .array(
        caseIdentity
          .extend({
            name: z.string().max(TEST_SUITES_BOUNDS.nameCharacters),
          })
          .strict(),
      )
      .max(WORKFLOW_TEST_SUITE_MAX_CASES),
  })
  .strict();
export const workflowTestSuitePreparationSchema = responseSchema(
  workflowTestSuiteCurrentSchema
    .extend({
      effectfulSteps: workflowTestPreparationSchema.shape.effectfulSteps,
    })
    .strict(),
);
export const workflowTestSuiteStartRequestSchema =
  workflowTestStartRequestSchema
    .omit({ input: true })
    .extend({
      expectedCases: z
        .array(caseIdentity)
        .min(1)
        .max(WORKFLOW_TEST_SUITE_MAX_CASES),
      expectedVariableSetRevision: z.number().int().positive().nullable(),
      signature: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict();
export const workflowTestSuiteAcceptedSchema = responseSchema(
  z.object({ suiteId: z.uuid() }).strict(),
);
export const workflowTestSuiteStatusSchema = z.enum([
  'running',
  'passed',
  'failed',
  'canceled',
  'error',
]);
export const workflowTestSuiteCaseStatusSchema = z.enum([
  'pending',
  'running',
  'passed',
  'failed',
  'error',
  'skipped',
]);
export const workflowTestSuiteSummarySchema = responseSchema(
  z
    .object({
      suiteId: z.uuid(),
      startedBy: z.uuid(),
      draftRevision: z.number().int().positive(),
      signature: z.string().regex(/^[0-9a-f]{64}$/u),
      status: workflowTestSuiteStatusSchema,
      stopReason: z
        .string()
        .max(TEST_SUITES_BOUNDS.stopReasonCharacters)
        .nullable(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
      expiresAt: z.iso.datetime(),
      total: z.number().int().min(1).max(WORKFLOW_TEST_SUITE_MAX_CASES),
      passed: z.number().int().min(0).max(WORKFLOW_TEST_SUITE_MAX_CASES),
      failed: z.number().int().min(0).max(WORKFLOW_TEST_SUITE_MAX_CASES),
      errors: z.number().int().min(0).max(WORKFLOW_TEST_SUITE_MAX_CASES),
      skipped: z.number().int().min(0).max(WORKFLOW_TEST_SUITE_MAX_CASES),
    })
    .strict(),
);
export const workflowTestSuiteListSchema = responseSchema(
  z
    .object({
      current: workflowTestSuiteCurrentSchema,
      items: z
        .array(workflowTestSuiteSummarySchema)
        .max(TEST_SUITES_BOUNDS.workflowTestSuiteListPageItems),
    })
    .strict(),
);
export const workflowTestSuiteDetailSchema = responseSchema(
  workflowTestSuiteSummarySchema
    .extend({
      cases: z
        .array(
          z
            .object({
              ordinal: z
                .number()
                .int()
                .min(0)
                .max(WORKFLOW_TEST_SUITE_MAX_CASES - 1),
              caseId: z.uuid(),
              caseRevision: z.number().int().positive(),
              name: z.string().max(TEST_SUITES_BOUNDS.nameCharacters),
              status: workflowTestSuiteCaseStatusSchema,
              runId: z.uuid().nullable(),
            })
            .strict(),
        )
        .max(WORKFLOW_TEST_SUITE_MAX_CASES),
    })
    .strict(),
);
export const workflowTestSuiteCaseReportSchema = responseSchema(
  z
    .object({
      report: workflowTestSuiteReportSchema.nullable(),
      stepLabels: z
        .record(
          z.string().max(TEST_SUITES_BOUNDS.stepLabelsCharacters),
          z.string().max(TEST_SUITES_BOUNDS.stepLabelsCharacters),
        )
        .refine(
          (value) =>
            Object.keys(value).length <= TEST_SUITES_BOUNDS.stepLabelsEntries,
        )
        .default({}),
    })
    .strict(),
);
export const workflowTestSuiteParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid(), suiteId: z.uuid() })
  .strict();
export const workflowTestSuiteCaseParamsSchema = workflowTestSuiteParamsSchema
  .extend({
    ordinal: z.coerce
      .number()
      .int()
      .min(0)
      .max(WORKFLOW_TEST_SUITE_MAX_CASES - 1),
  })
  .strict();
export type WorkflowTestSuiteCurrent = z.output<
  typeof workflowTestSuiteCurrentSchema
>;
export type WorkflowTestSuitePreparation = z.output<
  typeof workflowTestSuitePreparationSchema
>;
export type WorkflowTestSuiteStartRequest = z.output<
  typeof workflowTestSuiteStartRequestSchema
>;
export type WorkflowTestSuiteSummary = z.output<
  typeof workflowTestSuiteSummarySchema
>;
export type WorkflowTestSuiteDetail = z.output<
  typeof workflowTestSuiteDetailSchema
>;
export type WorkflowTestSuiteReport = z.output<
  typeof workflowTestSuiteReportSchema
>;
