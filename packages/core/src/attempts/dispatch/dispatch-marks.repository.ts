import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  nodeRuns,
  nodeAttempts,
  workflowRuns,
  connections,
  nodeAttemptConnectionDispatches,
} from '@pertexo/database/schema';
import { and, eq, sql, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { EXECUTION_SOURCE_SQL } from '../../shared/run-records/execution-source.repository.js';
import { runAbortReason } from '../control.repository.js';
import type { MarkDispatchedInput } from '../node-attempt.js';

type Lease = MarkDispatchedInput['lease'];

export const DISPATCHABLE_RUN_STATUSES = ['running', 'waiting'] as const;

const node = alias(nodeRuns, 'node');
const run = workflowRuns;

/** The leased node run's dispatch binding, locked; undefined when the lease moved on. */
export async function lockLeasedNodeBinding(
  client: PoolClient,
  lease: Lease,
): Promise<string | null | undefined> {
  const lockedNode = await drizzle(client)
    .select({ providerDispatchBinding: node.providerDispatchBinding })
    .from(node)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, node.workspaceId),
        eq(run.id, node.workflowRunId),
      ),
    )
    .where(
      and(
        eq(node.workspaceId, lease.workspaceId),
        eq(node.id, lease.nodeRunId),
        eq(node.workflowRunId, lease.runId),
        eq(node.nodeId, lease.nodeId),
        eq(node.invocationKey, lease.invocationKey),
        eq(node.currentAttemptId, lease.attemptId),
        eq(run.workflowVersionId, lease.workflowVersionId),
      ),
    )
    .for('update', { of: node })
    .catch(rethrowQueryFailure);
  return lockedNode[0]?.providerDispatchBinding;
}

export async function saveDispatchBinding(
  client: PoolClient,
  lease: Lease,
  binding: string,
): Promise<void> {
  await drizzle(client)
    .update(nodeRuns)
    .set({
      providerDispatchBinding: binding,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, lease.workspaceId),
        eq(nodeRuns.id, lease.nodeRunId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** When the attempt was first marked dispatched; undefined when its lease or run refuses. */
export async function markLeasedAttemptDispatched(
  client: PoolClient,
  lease: Lease,
): Promise<Date | undefined> {
  const result = await drizzle(client)
    .update(nodeAttempts)
    .set({
      dispatchMarkedAt: sql`coalesce(${nodeAttempts.dispatchMarkedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(node)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, node.workspaceId),
        eq(run.id, node.workflowRunId),
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
        eq(node.workspaceId, nodeAttempts.workspaceId),
        eq(node.id, nodeAttempts.nodeRunId),
        eq(node.workflowRunId, lease.runId),
        eq(node.nodeId, lease.nodeId),
        eq(node.invocationKey, lease.invocationKey),
        eq(node.currentAttemptId, nodeAttempts.id),
        eq(run.workflowVersionId, lease.workflowVersionId),
        inArray(run.status, DISPATCHABLE_RUN_STATUSES),
        isNull(runAbortReason),
      ),
    )
    .returning({
      dispatchedAt: sql<Date>`${nodeAttempts.dispatchMarkedAt}`.mapWith(
        nodeAttempts.dispatchMarkedAt,
      ),
    })
    .catch(rethrowQueryFailure);
  return result[0]?.dispatchedAt;
}

export async function readRunDispatchControl(client: PoolClient, lease: Lease) {
  const [control] = await drizzle(client)
    .select({ status: workflowRuns.status, reason: runAbortReason })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, lease.workspaceId),
        eq(workflowRuns.id, lease.runId),
      ),
    )
    .catch(rethrowQueryFailure);
  return control;
}

export async function readPublishedExecutable(
  client: PoolClient,
  lease: Lease,
): Promise<unknown> {
  const published = await drizzle(client)
    .select({ executableJson: EXECUTION_SOURCE_SQL.executable_json })
    .from(EXECUTION_SOURCE_SQL)
    .where(
      and(
        eq(EXECUTION_SOURCE_SQL.workspace_id, lease.workspaceId),
        eq(EXECUTION_SOURCE_SQL.id, lease.workflowVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return published[0]?.executableJson;
}

/** Remembers the secret and health revision a Slack send used. */
export async function recordSlackDispatch(
  client: PoolClient,
  lease: Lease,
  fence: NonNullable<MarkDispatchedInput['connectionFence']>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .insert(nodeAttemptConnectionDispatches)
    .select(
      db
        .select({
          workspaceId: connections.workspaceId,
          attemptId: sql<string>`${lease.attemptId}`.as('attempt_id'),
          connectionId: connections.id,
          providerKey: sql<string>`'slack'`.as('provider_key'),
          authType: sql<string>`'slack_bot_token'`.as('auth_type'),
          secretVersionId: sql<string>`${fence.secretVersionId}`.as(
            'secret_version_id',
          ),
          healthRevision: connections.healthRevision,
          workerId: sql<string>`${lease.workerId}`.as('worker_id'),
          fenceToken: sql<number>`${lease.fenceToken}`.as('fence_token'),
        })
        .from(connections)
        .where(
          and(
            eq(connections.workspaceId, lease.workspaceId),
            eq(connections.id, fence.connectionId),
          ),
        ),
    )
    .onConflictDoNothing({
      target: [
        nodeAttemptConnectionDispatches.workspaceId,
        nodeAttemptConnectionDispatches.attemptId,
      ],
    })
    .catch(rethrowQueryFailure);
}
