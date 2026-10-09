import type { PublishedWorkflowV2Projection } from './published-workflow.js';

/**
 * Builds a new run's first checkpoint for a published version. Every way a run
 * starts takes one; `@pertexo/execution` provides it.
 */
export type InitialCheckpointFactory = (
  projection: PublishedWorkflowV2Projection,
) => Readonly<{ engineVersion: string; checkpoint: unknown }>;
