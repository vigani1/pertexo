import type {
  WorkflowCheckpoint,
  WorkflowCheckpointV2,
  WorkflowCheckpointV1,
} from './types.js';
import { WorkflowEngineError } from './errors.js';
import {
  assertBoundedCheckpointJson,
  assertCheckpoint,
  isRecord,
} from './checkpoint-shared.js';
import { parseCheckpointV1Boundary } from './checkpoint-v1.js';
import { parseCheckpointV2Boundary } from './checkpoint-v2.js';

export function parseCheckpoint(value: unknown): WorkflowCheckpoint {
  try {
    assertBoundedCheckpointJson(value);
    if (isRecord(value) && value.schemaVersion === 1)
      return parseCheckpointV1Boundary(value);
    if (isRecord(value) && value.schemaVersion === 2)
      return parseCheckpointV2Boundary(value);
    throw new WorkflowEngineError(
      'checkpoint_unsupported',
      `Unsupported checkpoint schema version: ${String(isRecord(value) ? value.schemaVersion : undefined)}`,
    );
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

export function createCheckpointV2(input: {
  readonly engineVersion: string;
  readonly workflowVersionId: string;
  readonly iterationBudget: number;
  readonly nextEventSequence?: number;
}): WorkflowCheckpointV2 {
  return {
    ...createCheckpoint(input),
    schemaVersion: 2,
    branchSelections: [],
    initialIterationBudget: input.iterationBudget,
  };
}

export function createCheckpoint(input: {
  readonly engineVersion: string;
  readonly workflowVersionId: string;
  readonly iterationBudget: number;
  readonly nextEventSequence?: number;
}): WorkflowCheckpointV1 {
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
    engineVersion: input.engineVersion,
    workflowVersionId: input.workflowVersionId,
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

export { WORKFLOW_CHECKPOINT_LIMITS_V1 } from './checkpoint-shared.js';
