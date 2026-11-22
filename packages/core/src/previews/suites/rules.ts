import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkflowTestSuiteCurrent } from '@pertexo/contracts';
import { WorkflowTestError } from '../workflows/workflow-test.errors.js';
import type { WorkflowTestPreparation } from '../workflows/workflow-test.types.js';
import {
  assertEffectsAcknowledged,
  sameTestSamples,
} from '../workflows/rules.js';
import type {
  SuiteRow,
  WorkflowTestSuiteStartInput,
} from './workflow-test-suite.types.js';

/** One suite may hold every case at its longest, with room to spare. */
export const SUITE_MAX_DURATION_MS = 5 * 60 * 60 * 1_000;

export function assertPreparedSuite(
  input: WorkflowTestSuiteStartInput,
  current: WorkflowTestSuiteCurrent,
  effectfulSteps: WorkflowTestPreparation['effectfulSteps'],
): void {
  const savedCases =
    'expectedCases' in input.request ? input.request.expectedCases : undefined;
  if (savedCases !== undefined && current.cases.length === 0)
    throw new WorkflowTestError('cases_required');
  if (current.draftRevision !== input.request.expectedRevision)
    throw new WorkflowTestError('draft_changed');
  if (!sameTestSamples(current.samples, input.request.expectedSamples))
    throw new WorkflowTestError('samples_changed');
  const suiteChanged =
    current.variableSetRevision !== input.request.expectedVariableSetRevision ||
    current.signature !== input.request.signature ||
    (savedCases !== undefined &&
      canonicalJson(
        current.cases.map(({ id, revision }) => ({ id, revision })),
      ) !== canonicalJson(savedCases));
  if (suiteChanged) throw new WorkflowTestError('cases_changed');
  if (savedCases !== undefined)
    assertEffectsAcknowledged(input.request, effectfulSteps);
}

export function suiteOutcome(
  suite: Pick<SuiteRow, 'stopReason'>,
  nonpassing: number | undefined,
): 'canceled' | 'error' | 'passed' | 'failed' {
  if (
    suite.stopReason === 'user_canceled' ||
    suite.stopReason === 'case_canceled'
  ) {
    return 'canceled';
  }
  if (suite.stopReason !== null) {
    return 'error';
  }
  if (nonpassing === 0) {
    return 'passed';
  }
  return 'failed';
}
