import type { WorkflowCheckpoint } from '../types.js';
import { WorkflowEngineError } from '../errors.js';
import { assertBoundedCheckpointJson, isRecord } from './checkpoint-shared.js';
import { parseCheckpointV1Boundary } from './checkpoint-v1.js';
import { parseCheckpointV2Boundary } from './checkpoint-v2.js';
import { parseWorkflowCheckpointV3 } from './checkpoint-v3.js';
export { createCheckpoint, createCheckpointV2 } from './checkpoint-initial.js';

export function parseCheckpoint(value: unknown): WorkflowCheckpoint {
  try {
    assertBoundedCheckpointJson(value);
    if (isRecord(value) && value.schemaVersion === 1)
      return parseCheckpointV1Boundary(value);
    if (isRecord(value) && value.schemaVersion === 2)
      return parseCheckpointV2Boundary(value);
    if (isRecord(value) && value.schemaVersion === 3)
      return parseWorkflowCheckpointV3(value);
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

export { WORKFLOW_CHECKPOINT_LIMITS_V1 } from './checkpoint-shared.js';
