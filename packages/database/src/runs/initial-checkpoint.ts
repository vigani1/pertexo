import type { PublishedWorkflow } from './published-workflow.js';
import type { JsonValue } from '@pertexo/workflow-model';

/** Called after the ordinary storage boundary, before fresh acceptance effects. */
export type RunInputValidator = (
  value: JsonValue | undefined,
  storedBytes: number,
) => void;

/**
 * Builds a new run's first checkpoint for a published version. Every way a run
 * starts takes one; `@pertexo/execution` provides it.
 */
export type InitialCheckpointFactory = (
  projection: PublishedWorkflow,
) => Readonly<{ checkpoint: unknown; validateInput?: RunInputValidator }>;
