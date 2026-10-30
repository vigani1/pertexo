import { runAbortState } from '../queries/control.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool } from 'pg';
import { NodeAttemptReconciliationRequiredError } from '../errors.js';
import type { NodeAttemptRunStore } from '../contract.js';
import {
  assertNotAborted,
  withWorkspaceWriteClient,
} from '../transactions.repository.js';

export async function heartbeatNodeAttempt(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['heartbeat']>[0],
): Promise<
  Readonly<{
    leaseExpiresAt: Date;
    abortRequested: boolean;
    abortReason?: 'canceled' | 'timed_out';
  }>
> {
  assertNotAborted(input.signal);
  return withWorkspaceWriteClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const lease = input.lease;
      const result = await drizzle(client)
        .update(nodeAttempts)
        .set({
          leaseExpiresAt: sql`clock_timestamp()+make_interval(secs=>${input.leaseDurationSeconds})`,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(nodeRuns)
        .innerJoin(
          workflowRuns,
          and(
            eq(workflowRuns.workspaceId, nodeRuns.workspaceId),
            eq(workflowRuns.id, nodeRuns.workflowRunId),
          ),
        )
        .where(
          and(
            eq(nodeAttempts.workspaceId, lease.workspaceId),
            eq(nodeAttempts.id, lease.attemptId),
            eq(nodeAttempts.nodeRunId, lease.nodeRunId),
            eq(nodeAttempts.attemptNumber, lease.attemptNumber),
            eq(nodeAttempts.status, 'running'),
            eq(nodeAttempts.leaseOwner, lease.workerId),
            eq(nodeAttempts.fenceToken, lease.fenceToken),
            sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
            eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
            eq(nodeRuns.id, nodeAttempts.nodeRunId),
            eq(nodeRuns.workflowRunId, lease.runId),
            eq(nodeRuns.nodeId, lease.nodeId),
            eq(nodeRuns.invocationKey, lease.invocationKey),
            eq(nodeRuns.currentAttemptId, nodeAttempts.id),
            eq(workflowRuns.workflowVersionId, lease.workflowVersionId),
          ),
        )
        .returning({
          leaseExpiresAt: sql<Date>`${nodeAttempts.leaseExpiresAt}`.mapWith(
            nodeAttempts.leaseExpiresAt,
          ),
          ...runAbortState,
        })
        .catch(rethrowQueryFailure);
      const row = result[0];
      if (row === undefined) throw new NodeAttemptReconciliationRequiredError();
      return Object.freeze({
        leaseExpiresAt: row.leaseExpiresAt,
        abortRequested: row.abortRequested,
        ...(row.abortReason === null ? {} : { abortReason: row.abortReason }),
      });
    },
  );
}
