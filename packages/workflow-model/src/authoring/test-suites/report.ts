import { z } from 'zod';
import {
  testAssertionSchema,
  testExpectationValueSchema,
  WORKFLOW_TEST_LIMITS,
} from './workflow-test-expectations.schemas.js';

const observation = z
  .object({
    state: z.enum(['value', 'missing', 'unavailable', 'ambiguous']),
    matched: z.boolean(),
    value: testExpectationValueSchema.optional(),
    preview: z.string().max(WORKFLOW_TEST_LIMITS.previewUnits).optional(),
    bytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export const workflowTestSuiteReportSchema = z
  .object({
    expectedOutcome: z.enum(['succeeds', 'fails']),
    actualOutcome: z.enum([
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ]),
    outcomeMatched: z.boolean(),
    error: z
      .enum([
        'test_pin_required',
        'run_timed_out',
        'run_outcome_unknown',
        'run_canceled',
      ])
      .optional(),
    assertions: z
      .array(
        z
          .object({ assertion: testAssertionSchema, actual: observation })
          .strict(),
      )
      .max(WORKFLOW_TEST_LIMITS.assertions),
  })
  .strict();

export type SuiteCaseReport = z.output<typeof workflowTestSuiteReportSchema>;
