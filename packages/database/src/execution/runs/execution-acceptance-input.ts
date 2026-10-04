import { createHash } from 'node:crypto';

import {
  parseInitialWorkflowCheckpoint,
  serializePersistedWorkflowCheckpoint,
  PersistedWorkflowCheckpointInvalidError,
} from '../../compatibility/persisted-workflow-checkpoint.js';
import {
  parseInitialWorkflowCheckpointV3,
  serializePersistedWorkflowCheckpointV3,
} from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';

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
  // Select format only after the existing bounded data-only normalization.
  // Format selection is not version/admission authority: canonical persistence
  // must still prove the actual immutable executable and acceptance owner.
  let normalized: unknown;
  try {
    normalized = JSON.parse(
      serializeStoredExecutionJsonValue(input.initialCheckpoint),
    ) as unknown;
  } catch {
    // Preserve the retained checkpoint owner's public error classification.
    throw new PersistedWorkflowCheckpointInvalidError();
  }
  const native =
    typeof normalized === 'object' &&
    normalized !== null &&
    'schemaVersion' in normalized &&
    normalized.schemaVersion === 3;
  const identity = {
    engineVersion: input.engineVersion,
    workflowVersionId: input.workflowVersionId,
  };
  const initialCheckpointJson = native
    ? serializePersistedWorkflowCheckpointV3(
        parseInitialWorkflowCheckpointV3(normalized, identity),
      )
    : serializePersistedWorkflowCheckpoint(
        parseInitialWorkflowCheckpoint(normalized, identity),
      );
  return {
    initialCheckpointJson,
    initialCheckpointHash: createHash('sha256')
      .update(initialCheckpointJson)
      .digest('hex'),
  };
}
