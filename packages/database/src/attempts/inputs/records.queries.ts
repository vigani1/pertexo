import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { loadInputsSchema } from '../validation/delivery.js';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
  runCheckpoints,
} from '../../schema/runs/execution.js';
import { workflowCalls } from '../../schema/runs/calls.js';
import { pendingRunTasks } from '../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { runAbortState } from '../queries/control.js';

type Input = z.output<typeof loadInputsSchema>;

export async function readLeasedInputs(client: PoolClient, { lease }: Input) {
  return drizzle(client)
    .select({
      inputRef: workflowRuns.inputRef,
      variableSetRevision: workflowRuns.variableSetRevision,
      deadlineAt: workflowRuns.deadlineAt,
      schedulerState: runCheckpoints.schedulerState,
      ...runAbortState,
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
    .innerJoin(
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
        inArray(pendingRunTasks.status, ['approved', 'rejected', 'submitted']),
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
