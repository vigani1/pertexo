import { createHash } from 'node:crypto';

import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';

/**
 * Serializes a new run's first checkpoint. The checkpoint comes from the
 * engine (`InitialCheckpointFactory`); this checks only that it belongs to the
 * run row being written.
 */
export function prepareWorkflowRunAcceptanceInput(
  input: Readonly<{
    engineVersion: string;
    initialCheckpoint: unknown;
    replayCommandId?: string | undefined;
    replaySourceRunId?: string | undefined;
    triggerType: string;
    workflowVersionId: string;
  }>,
): Readonly<{ initialCheckpointJson: string; initialCheckpointHash: string }> {
  if (
    (input.replayCommandId === undefined) !==
    (input.replaySourceRunId === undefined)
  )
    throw new TypeError('Replay lineage must be provided together');
  if (
    (input.triggerType === 'replay') !==
    (input.replayCommandId !== undefined)
  )
    throw new TypeError('Replay lineage must match the replay trigger type');
  const checkpoint = input.initialCheckpoint as Readonly<
    Record<string, unknown>
  > | null;
  if (
    checkpoint?.workflowVersionId !== input.workflowVersionId ||
    checkpoint.engineVersion !== input.engineVersion ||
    checkpoint.revision !== 0
  )
    throw new TypeError('Initial checkpoint does not belong to this run');
  const initialCheckpointJson = serializeStoredExecutionJsonValue(checkpoint);
  return {
    initialCheckpointJson,
    initialCheckpointHash: createHash('sha256')
      .update(initialCheckpointJson)
      .digest('hex'),
  };
}
