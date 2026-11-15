import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { nodeRuns, runEvents } from '@pertexo/database/schema';
import type { RecoveryCopy } from '@pertexo/workflow-engine/server';
import { QUEUED_EVENT_SEQUENCE } from '../../shared/run-events.repository.js';
import { prepareStoredExecutionValue } from '../../shared/stored-execution.js';

/** A recovered run's reused prefix: its succeeded node runs, then one `node.reused` event each. */
export async function insertReusedNodeRuns(
  transaction: WorkspaceTransaction,
  runId: string,
  copies: readonly RecoveryCopy[],
) {
  await transaction.db.insert(nodeRuns).values(
    copies.map((copy) => ({
      id: copy.id,
      workspaceId: transaction.workspaceId,
      workflowRunId: runId,
      nodeId: copy.nodeId,
      invocationKey: copy.invocationKey,
      status: 'succeeded' as const,
      sideEffectClass: copy.sideEffectClass,
      ...(copy.providerIdempotencyKey === undefined
        ? {}
        : { providerIdempotencyKey: copy.providerIdempotencyKey }),
      branchContext:
        copy.branchPath === undefined ? {} : { branchPath: copy.branchPath },
      outputRef: sql`${prepareStoredExecutionValue({ kind: 'inline', value: copy.value }).json}::json`,
      reusedSourceRunId: copy.sourceRunId,
      reusedSourceNodeRunId: copy.sourceNodeRunId,
      reusedSourceCompletedAt: new Date(copy.sourceCompletedAt),
    })),
  );
  await transaction.db.insert(runEvents).values(
    copies.map((copy, index) => ({
      workspaceId: transaction.workspaceId,
      workflowRunId: runId,
      sequence: QUEUED_EVENT_SEQUENCE + 1 + index,
      type: 'node.reused',
      payload: {
        nodeId: copy.nodeId,
        nodeRunId: copy.id,
        outputRef: { kind: 'reused', nodeRunId: copy.id },
        invocationKey: copy.invocationKey,
        sourceRunId: copy.sourceRunId,
        sourceNodeRunId: copy.sourceNodeRunId,
        sourceCompletedAt: copy.sourceCompletedAt,
      },
    })),
  );
}
