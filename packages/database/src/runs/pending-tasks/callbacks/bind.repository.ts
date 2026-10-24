import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { nodeRuns } from '../../../schema/runs/execution.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { PendingTaskIntent } from '@pertexo/workflow-engine';
import { CoordinatorRunStateCorruptError } from '../../advance/contract.js';
import { callbackScopeHash } from './identity.repository.js';

export async function bindCallbackTask(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    intent,
    closed,
  }: Readonly<{
    runId: string;
    intent: Extract<PendingTaskIntent, { kind: 'callback' }>;
    closed: boolean;
  }>,
): Promise<Readonly<{ id: string; expires_at: Date; status: string }>> {
  const db = drizzle(client),
    node = nodeRuns,
    task = pendingRunTasks;
  const [owner] = await db
    .select({
      id: node.id,
      node_id: node.nodeId,
      branch_context: sql<
        Readonly<{ iterationPath?: unknown }>
      >`${node.branchContext}`,
    })
    .from(node)
    .where(
      and(
        eq(node.workspaceId, workspaceId),
        eq(node.workflowRunId, runId),
        eq(node.invocationKey, intent.invocationKey),
        eq(node.status, 'succeeded'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (owner === undefined) throw new CoordinatorRunStateCorruptError();
  // The update initializes the callback expiry from one post-lock clock observation.
  const [row] = await db
    .update(task)
    .set({
      nodeRunId: owner.id,
      invocationKey: intent.invocationKey,
      openedAt: sql`observed.time`,
      expiresAt: sql`observed.time+make_interval(secs=>${intent.config.timeoutSeconds})`,
      status: sql`case when ${closed} then 'canceled' when ${task.status}='prepared' then 'pending' else ${task.status} end`,
      outputRef: sql`case when ${closed} then null else ${task.outputRef} end`,
      completedAt: sql`case when ${closed} then coalesce(${task.completedAt},observed.time) else ${task.completedAt} end`,
    })
    .from(sql`(select clock_timestamp() time) observed`)
    .where(
      and(
        eq(task.workspaceId, workspaceId),
        eq(task.runId, runId),
        eq(task.callbackNodeId, owner.node_id),
        eq(
          task.callbackScopeHash,
          callbackScopeHash(owner.branch_context.iterationPath ?? []),
        ),
        isNull(task.nodeRunId),
        inArray(task.status, ['prepared', 'submitted']),
      ),
    )
    .returning({
      id: task.id,
      expires_at: sql<Date>`${task.expiresAt}`.mapWith(task.expiresAt),
      status: task.status,
    })
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  return row;
}
