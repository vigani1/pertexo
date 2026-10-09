import type {
  InitialCheckpointFactory,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/runs';
import {
  createCheckpoint,
  createCheckpointV2,
  type WorkflowCheckpoint,
} from '@pertexo/workflow-engine';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model/graph';

import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../workflows/verify-projection.js';

export const ENGINE_VERSION = 'phase3-engine-v1';

/** Branching, looping and parallel nodes need the structured (v2) checkpoint. */
export function requiresStructuredCheckpoint(
  definition: Readonly<{ key: string; version: number }>,
): boolean {
  return (
    (definition.version === 1 &&
      (definition.key === 'core.condition' ||
        definition.key === 'core.switch' ||
        definition.key === 'core.foreach')) ||
    (definition.key === 'core.parallel' &&
      (definition.version === 1 ||
        definition.version === 2 ||
        definition.version === 3))
  );
}

/**
 * The first checkpoint of a new run of a published workflow, for every way a
 * run starts. Throws `WorkflowEngineError` when this release cannot run it.
 */
export function createInitialCheckpoint(
  projection: PublishedWorkflowV2Projection,
  verification: PersistedWorkflowProjectionVerificationOptions,
): Readonly<{ engineVersion: string; checkpoint: WorkflowCheckpoint }> {
  const executable = verifyPersistedWorkflowProjection(
    projection,
    verification,
  );
  const create = executable.envelope.graph.nodes.some(({ definition }) =>
    requiresStructuredCheckpoint(definition),
  )
    ? createCheckpointV2
    : createCheckpoint;
  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    checkpoint: create({
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
