import { and, eq, sql } from 'drizzle-orm';
import {
  parseWorkflowGraphDraft,
  stepSampleBindings,
} from '@pertexo/workflow-model';
import { workflowStepSamples } from '../../schema.js';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { WorkflowStepSampleError } from '../../authoring/step-samples/contract.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

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
  const clock = await transaction.db.execute<{ now: Date }>(
    sql`select clock_timestamp() now`,
  );
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Preview sample time is unavailable');
  if (sample.expiresAt <= new Date(now))
    throw new WorkflowStepSampleError('expired');
  const binding = stepSampleBindings(parseWorkflowGraphDraft(graph)).get(
    input.nodeId,
  );
  if (binding === undefined || binding !== sample.binding)
    throw new WorkflowStepSampleError('stale');
  return { id: sample.id, output: parseStoredExecutionValue(sample.outputRef) };
}
