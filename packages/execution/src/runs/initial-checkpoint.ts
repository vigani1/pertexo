import type {
  InitialCheckpointFactory,
  PublishedWorkflow,
} from '@pertexo/database/runs';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/database/platform';
import {
  createCheckpoint,
  type WorkflowCheckpoint,
} from '@pertexo/workflow-engine';
import {
  CallableInputInvalidError,
  validateCallableValue,
  WORKFLOW_GRAPH_LIMITS,
  type JsonValue,
} from '@pertexo/workflow-model';

import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../workflows/verify-projection.js';

/**
 * The first checkpoint of a new run of a published workflow, for every way a
 * run starts. Throws `WorkflowEngineError` when the served catalog cannot run it.
 */
export function createInitialCheckpoint(
  projection: PublishedWorkflow,
  verification: PersistedWorkflowProjectionVerificationOptions,
): ReturnType<InitialCheckpointFactory> &
  Readonly<{ checkpoint: WorkflowCheckpoint }> {
  const executable = verifyPersistedWorkflowProjection(
    projection,
    verification,
  );
  const callable = executable.envelope.graph.callable;
  return Object.freeze({
    checkpoint: createCheckpoint({
      workflowVersionId: projection.id,
      iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
      nextEventSequence: 2,
    }),
    ...(callable === undefined
      ? {}
      : {
          validateInput: (
            value: JsonValue | undefined,
            storedBytes: number,
          ) => {
            if (value === undefined)
              throw new CallableInputInvalidError('missing');
            if (storedBytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes)
              throw new CallableInputInvalidError('bounds');
            const issue = validateCallableValue(callable.input, value);
            if (issue !== undefined) throw new CallableInputInvalidError(issue);
          },
        }),
  });
}

/** The factory every run start takes, bound to the served catalog. */
export function initialCheckpointFactory(
  verification: PersistedWorkflowProjectionVerificationOptions,
): InitialCheckpointFactory {
  return (projection) => createInitialCheckpoint(projection, verification);
}
