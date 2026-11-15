import { decodeStoredValue } from '../../shared/stored-values.js';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
} from '@pertexo/workflow-model';
import { parseStoredExecutionValue } from '../../shared/stored-execution.js';
import { WorkflowStepSampleError } from '../../authoring/step-samples/step-sample.errors.js';
import { readDatabaseClock } from '../../shared/database-clock.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { lockStepSample } from './samples.repository.js';

export async function resolvePreviewSample(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    workflowId: string;
    nodeId: string;
    expectedSampleId?: string | null;
  }>,
  graph: unknown,
) {
  const sample = await lockStepSample(transaction, input);
  if (
    input.expectedSampleId !== undefined &&
    (sample?.id ?? null) !== input.expectedSampleId
  )
    throw new WorkflowStepSampleError('changed');
  if (sample === undefined) return undefined;
  // Read time after the row lock: a waiter may have crossed expiry without a row change.
  if (sample.expiresAt <= (await readDatabaseClock(transaction.db)))
    throw new WorkflowStepSampleError('expired');
  const binding = stepSampleBindings(
    decodeStoredValue(() => parseWorkflowGraphDraft(graph)),
  ).get(input.nodeId);
  if (binding === undefined || binding !== sample.binding)
    throw new WorkflowStepSampleError('stale');
  return {
    id: sample.id,
    output: decodeStoredValue(() =>
      parseStoredExecutionValue(sample.outputRef),
    ),
  };
}
