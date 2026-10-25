import {
  observeTestAssertion,
  type JsonValue,
  type SuiteCaseReport,
  type TestAssertionObservation,
  type WorkflowTestExpectations,
} from '@pertexo/workflow-model';

export type SuiteRunStatus = SuiteCaseReport['actualOutcome'];
export type SuiteOutput =
  { state: 'value'; value: JsonValue } | { state: 'unavailable' | 'ambiguous' };
export type { SuiteCaseReport } from '@pertexo/workflow-model';
export interface SuiteRunOutcome {
  status: SuiteRunStatus;
  pinRequired: boolean;
}

/** Evaluates only the frozen expectations and selected outputs supplied by storage. */
export function evaluateSuiteExpectations(
  expectations: WorkflowTestExpectations,
  run: SuiteRunOutcome,
  outputs: ReadonlyMap<string, SuiteOutput>,
): { status: 'passed' | 'failed' | 'error'; report: SuiteCaseReport } {
  const outcomeMatched =
    run.status ===
    (expectations.outcome === 'succeeds' ? 'succeeded' : 'failed');
  const error = suiteRunError(run);
  const assertions = expectations.assertions.map((assertion) => {
    const output = outputs.get(
      assertion.source.kind === 'final'
        ? 'final'
        : `step:${assertion.source.nodeId}`,
    ) ?? { state: 'unavailable' as const };
    const actual: TestAssertionObservation =
      output.state === 'value'
        ? observeTestAssertion(output.value, assertion)
        : { state: output.state, matched: false };
    return { assertion, actual };
  });
  const report: SuiteCaseReport = {
    expectedOutcome: expectations.outcome,
    actualOutcome: run.status,
    outcomeMatched,
    ...(error === undefined ? {} : { error }),
    assertions,
  };
  return {
    status: suiteCaseStatus({ error, outcomeMatched, assertions }),
    report,
  };
}

function suiteRunError(run: SuiteRunOutcome): SuiteCaseReport['error'] {
  if (run.pinRequired) {
    return 'test_pin_required';
  }
  if (run.status === 'timed_out') {
    return 'run_timed_out';
  }
  if (run.status === 'outcome_unknown') {
    return 'run_outcome_unknown';
  }
  if (run.status === 'canceled') {
    return 'run_canceled';
  }
  return undefined;
}

function suiteCaseStatus(
  input: Readonly<{
    error: SuiteCaseReport['error'];
    outcomeMatched: boolean;
    assertions: SuiteCaseReport['assertions'];
  }>,
): 'error' | 'passed' | 'failed' {
  const { error, outcomeMatched, assertions } = input;
  if (error !== undefined) {
    return 'error';
  }
  if (outcomeMatched && assertions.every((item) => item.actual.matched)) {
    return 'passed';
  }
  return 'failed';
}
