import type {
  InitialCheckpointFactory,
  PublishedWorkflowV2Projection,
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

export const ENGINE_VERSION = 'phase3-engine-v1';

/**
 * The first checkpoint of a new run of a published workflow, for every way a
 * run starts. Throws `WorkflowEngineError` when this release cannot run it.
 */
export function createInitialCheckpoint(
  projection: PublishedWorkflowV2Projection,
  verification: PersistedWorkflowProjectionVerificationOptions,
): Readonly<{ engineVersion: string; checkpoint: WorkflowCheckpoint }> {
  verifyPersistedWorkflowProjection(projection, verification);
  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    checkpoint: createCheckpoint({
      engineVersion: ENGINE_VERSION,
      workflowVersionId: projection.id,
      iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
      nextEventSequence: 2,
    }),
  });
}

/** The factory every run start takes, bound to this release's support. */
export function initialCheckpointFactory(
  verification: PersistedWorkflowProjectionVerificationOptions,
): InitialCheckpointFactory {
  return (projection, currentCompatibilityRelease) =>
    createInitialCheckpoint(
      { ...projection, currentCompatibilityRelease },
      verification,
    );
}
