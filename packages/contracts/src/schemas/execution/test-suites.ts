import { workflowTestSuiteReportSchema } from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  workflowTestPreparationSchema,
  workflowTestStartRequestSchema,
} from './workflow-tests.js';
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
      .array(caseIdentity.extend({ name: z.string().max(128) }).strict())
      .max(50),
  })
  .strict();
export const workflowTestSuitePreparationSchema = workflowTestSuiteCurrentSchema
  .extend({
    effectfulSteps: workflowTestPreparationSchema.shape.effectfulSteps,
  })
  .strict();
export const workflowTestSuiteStartRequestSchema =
  workflowTestStartRequestSchema
    .omit({ input: true })
    .extend({
      expectedCases: z.array(caseIdentity).min(1).max(50),
      expectedVariableSetRevision: z.number().int().positive().nullable(),
      signature: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict();
export const workflowTestSuiteAcceptedSchema = z
  .object({ suiteId: z.uuid() })
  .strict();
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
export const workflowTestSuiteSummarySchema = z
  .object({
    suiteId: z.uuid(),
    startedBy: z.uuid(),
    draftRevision: z.number().int().positive(),
    signature: z.string().regex(/^[0-9a-f]{64}$/u),
    status: workflowTestSuiteStatusSchema,
    stopReason: z.string().max(64).nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime(),
    total: z.number().int().min(1).max(50),
    passed: z.number().int().min(0).max(50),
    failed: z.number().int().min(0).max(50),
    errors: z.number().int().min(0).max(50),
    skipped: z.number().int().min(0).max(50),
  })
  .strict();
export const workflowTestSuiteListSchema = z
  .object({
    current: workflowTestSuiteCurrentSchema,
    items: z.array(workflowTestSuiteSummarySchema).max(20),
  })
  .strict();
export const workflowTestSuiteDetailSchema = workflowTestSuiteSummarySchema
  .extend({
    cases: z
      .array(
        z
          .object({
            ordinal: z.number().int().min(0).max(49),
            caseId: z.uuid(),
            caseRevision: z.number().int().positive(),
            name: z.string().max(128),
            status: workflowTestSuiteCaseStatusSchema,
            runId: z.uuid().nullable(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export const workflowTestSuiteCaseReportSchema = z
  .object({
    report: workflowTestSuiteReportSchema.nullable(),
    stepLabels: z
      .record(z.string().max(256), z.string().max(256))
      .refine((value) => Object.keys(value).length <= 20)
      .default({}),
  })
  .strict();
export const workflowTestSuiteParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid(), suiteId: z.uuid() })
  .strict();
export const workflowTestSuiteCaseParamsSchema = workflowTestSuiteParamsSchema
  .extend({ ordinal: z.coerce.number().int().min(0).max(49) })
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
