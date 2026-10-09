import type { WorkflowCheckpoint } from '../types.js';
import { WorkflowEngineError } from '../errors.js';
import { assertBoundedCheckpointJson, assertCheckpoint } from './fields.js';
import { parseCheckpointRecord } from './record.js';
import {
  assertPersistedEngineVersion,
  assertPersistedWorkflowVersionId,
} from './identity.js';

export function parseCheckpoint(value: unknown): WorkflowCheckpoint {
  try {
    assertBoundedCheckpointJson(value);
    return parseCheckpointRecord(value);
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      error instanceof Error ? error.message : 'checkpoint parsing failed',
    );
  }
}

export function reconstructReadySet(
  checkpoint: WorkflowCheckpoint,
): readonly string[] {
  return checkpoint.invocations
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey)
    .sort();
}

export function createCheckpoint(input: {
  readonly engineVersion: string;
  readonly workflowVersionId: string;
  readonly iterationBudget: number;
  readonly nextEventSequence?: number;
}): WorkflowCheckpoint {
  const engineVersion = assertPersistedEngineVersion(input.engineVersion);
  const workflowVersionId = assertPersistedWorkflowVersionId(
    input.workflowVersionId,
  );
  assertCheckpoint(
    Number.isSafeInteger(input.iterationBudget) && input.iterationBudget >= 0,
    'iterationBudget is invalid',
  );
  assertCheckpoint(
    input.nextEventSequence === undefined ||
      (Number.isSafeInteger(input.nextEventSequence) &&
        input.nextEventSequence > 0),
    'nextEventSequence is invalid',
  );
  return {
    schemaVersion: 2,
    engineVersion,
    workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: input.nextEventSequence ?? 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: input.iterationBudget,
    cancelRequested: false,
    deadlineExpired: false,
    branchSelections: [],
    initialIterationBudget: input.iterationBudget,
  };
}

export { WORKFLOW_CHECKPOINT_LIMITS } from './fields.js';
