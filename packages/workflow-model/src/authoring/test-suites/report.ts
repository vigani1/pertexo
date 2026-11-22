import { z } from 'zod';
import {
  testAssertionSchema,
  testExpectationValueSchema,
  WORKFLOW_TEST_LIMITS,
} from './workflow-test-expectations.schemas.js';
import { WORKFLOW_INPUT_CASE_LIMITS } from './input-case-limits.js';

/**
 * How many saved input cases one suite runs: every case a workflow may keep,
 * so a suite that reads one more knows the cases changed.
 */
export const WORKFLOW_TEST_SUITE_MAX_CASES =
  WORKFLOW_INPUT_CASE_LIMITS.perWorkflow;

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
        'run_infrastructure_failed',
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

/** Only completed cases contribute assertions to the denominator. */
export function scoreSuiteCases(
  cases: readonly Readonly<{
    status: 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';
    report: SuiteCaseReport | null;
  }>[],
) {
  const score = { matched: 0, total: 0, failedRuns: 0, incompleteCases: 0 };
  for (const { status, report } of cases) {
    if (status === 'pending' || status === 'running') continue;
    if (report === null || report.error !== undefined) {
      score.incompleteCases += 1;
      continue;
    }
    if (report.actualOutcome === 'failed') score.failedRuns += 1;
    for (const { actual } of report.assertions) {
      score.total += 1;
      if (actual.matched) score.matched += 1;
    }
  }
  return score;
}
