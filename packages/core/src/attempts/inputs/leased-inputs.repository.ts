import type { LoadInputsInput, RecordInputInput } from '../node-attempt.js';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
  runCheckpoints,
  workflowCalls,
  pendingRunTasks,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { runAbortReason } from '../control.repository.js';

type Input = LoadInputsInput;

export async function readLeasedInputs(client: PoolClient, { lease }: Input) {
  return drizzle(client)
    .select({
      inputRef: workflowRuns.inputRef,
      variableSetRevision: workflowRuns.variableSetRevision,
      deadlineAt: workflowRuns.deadlineAt,
      schedulerState: runCheckpoints.schedulerState,
      abortReason: runAbortReason,
    })
    .from(workflowRuns)
    .innerJoin(
      nodeRuns,
      and(
        eq(nodeRuns.workspaceId, workflowRuns.workspaceId),
        eq(nodeRuns.workflowRunId, workflowRuns.id),
      ),
    )
    .innerJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
      ),
    )
    .leftJoin(
      runCheckpoints,
      and(
        eq(runCheckpoints.workspaceId, workflowRuns.workspaceId),
        eq(runCheckpoints.workflowRunId, workflowRuns.id),
      ),
    )
    .where(
      and(
        eq(workflowRuns.workspaceId, lease.workspaceId),
        eq(workflowRuns.id, lease.runId),
        eq(workflowRuns.workflowVersionId, lease.workflowVersionId),
        eq(nodeRuns.id, lease.nodeRunId),
        eq(nodeRuns.nodeId, lease.nodeId),
        eq(nodeRuns.invocationKey, lease.invocationKey),
        eq(nodeRuns.currentAttemptId, lease.attemptId),
        eq(nodeRuns.currentAttemptNumber, lease.attemptNumber),
        eq(nodeAttempts.id, lease.attemptId),
        eq(nodeAttempts.attemptNumber, lease.attemptNumber),
        eq(nodeAttempts.status, 'running'),
        eq(nodeAttempts.leaseOwner, lease.workerId),
        eq(nodeAttempts.fenceToken, lease.fenceToken),
        sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function readUpstreamOutputs(client: PoolClient, input: Input) {
  return drizzle(client)
    .select({
      currentAttemptId: nodeRuns.currentAttemptId,
      currentAttemptNumber: nodeRuns.currentAttemptNumber,
      reusedSourceRunId: nodeRuns.reusedSourceRunId,
      reusedSourceNodeRunId: nodeRuns.reusedSourceNodeRunId,
      reusedSourceCompletedAt: nodeRuns.reusedSourceCompletedAt,
      attemptStatus: nodeAttempts.status,
      invocationKey: nodeRuns.invocationKey,
      nodeId: nodeRuns.nodeId,
      nodeOutputRef: nodeRuns.outputRef,
      attemptOutputRef: sql<unknown>`case when ${pendingRunTasks.id} is not null then ${pendingRunTasks.outputRef} when ${workflowCalls.id} is not null then ${workflowCalls.resultRef} else ${nodeAttempts.outputRef} end`,
    })
    .from(nodeRuns)
    .leftJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.id, nodeRuns.currentAttemptId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
      ),
    )
    .leftJoin(
      workflowCalls,
      and(
        eq(workflowCalls.workspaceId, nodeRuns.workspaceId),
        eq(workflowCalls.parentRunId, nodeRuns.workflowRunId),
        eq(workflowCalls.invocationKey, nodeRuns.invocationKey),
        eq(workflowCalls.status, 'succeeded'),
      ),
    )
    .leftJoin(
      pendingRunTasks,
      and(
        eq(pendingRunTasks.workspaceId, nodeRuns.workspaceId),
        eq(pendingRunTasks.nodeRunId, nodeRuns.id),
        eq(pendingRunTasks.runId, nodeRuns.workflowRunId),
        isNotNull(pendingRunTasks.outputRef),
      ),
    )
    .where(
      and(
        eq(nodeRuns.workspaceId, input.lease.workspaceId),
        eq(nodeRuns.workflowRunId, input.lease.runId),
        inArray(
          nodeRuns.invocationKey,
          input.upstreamNodeOutputs.map(({ invocationKey }) => invocationKey),
        ),
        eq(nodeRuns.status, 'succeeded'),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Whether the input was written: the lease must still be live and held. */
export async function writeLeasedAttemptInput(
  client: PoolClient,
  lease: RecordInputInput['lease'],
  stored: string,
): Promise<boolean> {
  const result = await drizzle(client)
    .update(nodeRuns)
    .set({
      inputRef: sql`${stored}::json`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(nodeAttempts)
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, nodeAttempts.workspaceId),
        eq(workflowRuns.id, lease.runId),
      ),
    )
    .where(
      and(
        eq(nodeRuns.workspaceId, lease.workspaceId),
        eq(nodeRuns.id, lease.nodeRunId),
        eq(nodeRuns.currentAttemptId, lease.attemptId),
        eq(nodeRuns.workflowRunId, lease.runId),
        eq(nodeRuns.nodeId, lease.nodeId),
        eq(nodeRuns.invocationKey, lease.invocationKey),
        eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
        eq(nodeAttempts.id, lease.attemptId),
        eq(nodeAttempts.nodeRunId, nodeRuns.id),
        eq(nodeAttempts.attemptNumber, lease.attemptNumber),
        eq(nodeAttempts.status, 'running'),
        eq(nodeAttempts.leaseOwner, lease.workerId),
        eq(nodeAttempts.fenceToken, lease.fenceToken),
        sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
        eq(workflowRuns.workflowVersionId, lease.workflowVersionId),
      ),
    )
    .returning({ id: nodeRuns.id })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}

/** The output a waiting step resumes with, held on its node run. */
export async function readResumeOutput(
  client: PoolClient,
  lease: LoadInputsInput['lease'],
) {
  const resumed = await drizzle(client)
    .select({ outputRef: nodeRuns.outputRef })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, lease.workspaceId),
        eq(nodeRuns.id, lease.nodeRunId),
        eq(nodeRuns.currentAttemptId, lease.attemptId),
      ),
    )
    .catch(rethrowQueryFailure);
  return resumed[0];
}

/** The failed step this failure handler runs for, while its lease is live. */
export function readSourceFailureRows(
  client: PoolClient,
  {
    lease,
    sourceFailure,
  }: Readonly<{
    lease: LoadInputsInput['lease'];
    sourceFailure: NonNullable<LoadInputsInput['sourceFailure']>;
  }>,
) {
  const sourceNode = alias(nodeRuns, 'source');
  const handler = alias(nodeRuns, 'handler');
  return drizzle(client)
    .select({
      failureRef: sourceNode.failureRef,
      invocationKey: sourceNode.invocationKey,
      currentAttemptNumber: sourceNode.currentAttemptNumber,
    })
    .from(sourceNode)
    .innerJoin(
      handler,
      and(
        eq(handler.workspaceId, sourceNode.workspaceId),
        eq(handler.workflowRunId, sourceNode.workflowRunId),
        eq(handler.invocationKey, sourceNode.failureHandlerEntryKey),
      ),
    )
    .innerJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.workspaceId, handler.workspaceId),
        eq(nodeAttempts.nodeRunId, handler.id),
      ),
    )
    .where(
      and(
        eq(sourceNode.workspaceId, lease.workspaceId),
        eq(sourceNode.workflowRunId, lease.runId),
        eq(sourceNode.nodeId, sourceFailure.nodeId),
        eq(sourceNode.status, 'failed'),
        eq(sourceNode.failureHandling, 'pending'),
        eq(handler.id, lease.nodeRunId),
        eq(handler.currentAttemptId, lease.attemptId),
        eq(handler.currentAttemptNumber, lease.attemptNumber),
        eq(nodeAttempts.id, lease.attemptId),
        eq(nodeAttempts.attemptNumber, lease.attemptNumber),
        eq(nodeAttempts.status, 'running'),
        eq(nodeAttempts.leaseOwner, lease.workerId),
        eq(nodeAttempts.fenceToken, lease.fenceToken),
        sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
      ),
    )
    .catch(rethrowQueryFailure);
}
