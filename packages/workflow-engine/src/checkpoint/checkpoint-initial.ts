import type { WorkflowCheckpointV1, WorkflowCheckpointV2 } from '../types.js';
import {
  assertPersistedEngineVersion,
  assertPersistedWorkflowVersionId,
} from './checkpoint-identity.js';
import { assertCheckpoint } from './checkpoint-shared.js';

interface InitialCheckpointInput {
  readonly engineVersion: string;
  readonly workflowVersionId: string;
  readonly iterationBudget: number;
  readonly nextEventSequence?: number;
}

export function createCheckpointV2(
  input: InitialCheckpointInput,
): WorkflowCheckpointV2 {
  return {
    ...createCheckpoint(input),
    schemaVersion: 2,
    branchSelections: [],
    initialIterationBudget: input.iterationBudget,
  };
}

export function createCheckpoint(
  input: InitialCheckpointInput,
): WorkflowCheckpointV1 {
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
    schemaVersion: 1,
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
  };
}
