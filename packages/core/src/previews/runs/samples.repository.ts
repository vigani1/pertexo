import { decodeStoredValue } from '../../shared/stored-values.js';
import { and, eq } from 'drizzle-orm';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
} from '@pertexo/workflow-model';
import { workflowStepSamples } from '@pertexo/database/schema';
import { parseStoredExecutionValue } from '../../runs/values/stored-execution.js';
import { WorkflowStepSampleError } from '../../authoring/step-samples/step-sample.errors.js';
import { readDatabaseClock } from '../clock.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

export async function resolvePreviewSample(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    workflowId: string;
    nodeId: string;
    expectedSampleId?: string | null;
  }>,
  graph: unknown,
) {
  const rows = await transaction.db
    .select()
    .from(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, transaction.workspaceId),
        eq(workflowStepSamples.workflowId, input.workflowId),
        eq(workflowStepSamples.nodeId, input.nodeId),
      ),
    )
    .for('share')
    .limit(1);
  const sample = rows[0];
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
