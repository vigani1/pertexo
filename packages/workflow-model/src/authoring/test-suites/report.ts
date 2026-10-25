import { z } from 'zod';
import { testAssertionSchema, testExpectationValueSchema } from './contract.js';

const observation = z
  .object({
    state: z.enum(['value', 'missing', 'unavailable', 'ambiguous']),
    matched: z.boolean(),
    value: testExpectationValueSchema.optional(),
    preview: z.string().max(4000).optional(),
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
      .max(20),
  })
  .strict();

export type SuiteCaseReport = z.output<typeof workflowTestSuiteReportSchema>;
