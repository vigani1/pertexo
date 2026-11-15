import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { nodeRuns, nodeAttempts, workflowRuns } from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { runAbortReason } from '../control.repository.js';
import type { ClaimDeliveryInput, HeartbeatInput } from '../node-attempt.js';

/** Leases the attempt to this worker with a new fence token. */
export async function startAttemptLease(
  client: PoolClient,
  input: ClaimDeliveryInput,
): Promise<Readonly<{ fenceToken: number; leaseExpiresAt: Date }> | undefined> {
  const claimed = await drizzle(client)
    .update(nodeAttempts)
    .set({
      status: 'running',
      leaseOwner: input.workerId,
      leaseExpiresAt: sql`clock_timestamp()+make_interval(secs=>${input.leaseDurationSeconds})`,
      fenceToken: sql`${nodeAttempts.fenceToken}+1`,
      startedAt: sql`coalesce(${nodeAttempts.startedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeAttempts.workspaceId, input.workspaceId),
        eq(nodeAttempts.id, input.attemptId),
      ),
    )
    .returning({
      fenceToken: nodeAttempts.fenceToken,
      leaseExpiresAt: sql<Date>`${nodeAttempts.leaseExpiresAt}`.mapWith(
        nodeAttempts.leaseExpiresAt,
      ),
    })
    .catch(rethrowQueryFailure);
  return claimed[0];
}

export async function markNodeRunStarted(
  client: PoolClient,
  input: ClaimDeliveryInput,
): Promise<void> {
  await drizzle(client)
    .update(nodeRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${nodeRuns.startedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, input.workspaceId),
        eq(nodeRuns.id, input.nodeRunId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Extends a live lease the worker still holds; undefined when it no longer does. */
export async function extendAttemptLease(
  client: PoolClient,
  { lease, leaseDurationSeconds }: HeartbeatInput,
) {
  const result = await drizzle(client)
    .update(nodeAttempts)
    .set({
      leaseExpiresAt: sql`clock_timestamp()+make_interval(secs=>${leaseDurationSeconds})`,
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
      abortReason: runAbortReason,
    })
    .catch(rethrowQueryFailure);
  return result[0];
}
