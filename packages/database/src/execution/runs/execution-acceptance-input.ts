import { createHash } from 'node:crypto';

import {
  parseInitialWorkflowCheckpoint,
  serializePersistedWorkflowCheckpoint,
} from '../../compatibility/persisted-workflow-checkpoint.js';

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
  const initialCheckpointJson = serializePersistedWorkflowCheckpoint(
    parseInitialWorkflowCheckpoint(input.initialCheckpoint, {
      engineVersion: input.engineVersion,
      workflowVersionId: input.workflowVersionId,
    }),
  );
  return {
    initialCheckpointJson,
    initialCheckpointHash: createHash('sha256')
      .update(initialCheckpointJson)
      .digest('hex'),
  };
}
