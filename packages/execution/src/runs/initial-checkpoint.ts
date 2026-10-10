import type {
  InitialCheckpointFactory,
  PublishedWorkflow,
} from '@pertexo/database/runs';
import {
  createCheckpoint,
  type WorkflowCheckpoint,
} from '@pertexo/workflow-engine';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';

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
): Readonly<{ checkpoint: WorkflowCheckpoint }> {
  verifyPersistedWorkflowProjection(projection, verification);
  return Object.freeze({
    checkpoint: createCheckpoint({
      workflowVersionId: projection.id,
      iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
      nextEventSequence: 2,
    }),
  });
}

/** The factory every run start takes, bound to the served catalog. */
export function initialCheckpointFactory(
  verification: PersistedWorkflowProjectionVerificationOptions,
): InitialCheckpointFactory {
  return (projection) => createInitialCheckpoint(projection, verification);
}
