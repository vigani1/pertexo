import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkflowTestSuiteCurrent } from '@pertexo/contracts';
import { WorkflowTestError } from '../workflows/errors.js';
import type { WorkflowTestPreparation } from '../workflows/contract.js';
import {
  assertEffectsAcknowledged,
  sameTestSamples,
} from '../workflows/rules.js';
import type { SuiteRow, WorkflowTestSuiteStartInput } from './contract.js';

/** More cases can't be added than this, so reading one more proves a change. */
export const SUITE_MAX_CASES = 50;
/** One suite may hold every case at its longest, with room to spare. */
export const SUITE_MAX_DURATION_MS = 5 * 60 * 60 * 1_000;

export function assertPreparedSuite(
  input: WorkflowTestSuiteStartInput,
  current: WorkflowTestSuiteCurrent,
  effectfulSteps: WorkflowTestPreparation['effectfulSteps'],
): void {
  if (current.cases.length === 0) throw new WorkflowTestError('cases_required');
  if (current.draftRevision !== input.request.expectedRevision)
    throw new WorkflowTestError('draft_changed');
  if (!sameTestSamples(current.samples, input.request.expectedSamples))
    throw new WorkflowTestError('samples_changed');
  const suiteChanged =
    current.variableSetRevision !== input.request.expectedVariableSetRevision ||
    current.signature !== input.request.signature ||
    canonicalJson(
      current.cases.map(({ id, revision }) => ({ id, revision })),
    ) !== canonicalJson(input.request.expectedCases);
  if (suiteChanged) throw new WorkflowTestError('cases_changed');
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
