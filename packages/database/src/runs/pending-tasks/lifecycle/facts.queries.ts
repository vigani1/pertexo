import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { nodeRuns, workflowRuns } from '../../../schema/runs/execution.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { PendingTaskOutcome } from '@pertexo/workflow-engine';
import { wakeTaskAncestors } from '../responses/respond.repository.js';

/** Database time resolves expiry; the existing due-node scanner supplies wakeups. */
export async function readPendingTaskFacts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<readonly PendingTaskOutcome[]> {
  const db = drizzle(client),
    task = pendingRunTasks,
    run = workflowRuns,
    node = nodeRuns;
  const expired = await db
    .update(task)
    .set({ status: 'expired', completedAt: sql`clock_timestamp()` })
    .from(run)
    .where(
      and(
        eq(task.workspaceId, workspaceId),
        eq(task.runId, runId),
        eq(task.status, 'pending'),
        sql`${task.expiresAt}<=clock_timestamp()`,
        eq(run.workspaceId, task.workspaceId),
        eq(run.id, task.runId),
        inArray(run.status, ['queued', 'running', 'waiting']),
        isNull(run.cancelRequestedAt),
      ),
    )
    .returning({ id: task.id })
    .catch(rethrowQueryFailure);
  if (expired.length > 0) await wakeTaskAncestors(client, workspaceId, runId);
  // The filter excludes pending/prepared callbacks; completed outcomes follow the task state CHECK.
  const rows = await db
    .select({
      id: task.id,
      invocation_key: task.invocationKey,
      status: sql<PendingTaskOutcome['status']>`${task.status}`,
      node_id: node.nodeId,
      branch_context: sql<
        Pick<PendingTaskOutcome, 'branchPath' | 'iterationPath'>
      >`${node.branchContext}`,
    })
    .from(task)
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, task.workspaceId),
        eq(node.id, task.nodeRunId),
        eq(node.workflowRunId, task.runId),
        eq(node.invocationKey, task.invocationKey),
      ),
    )
    .where(
      and(
        eq(task.workspaceId, workspaceId),
        eq(task.runId, runId),
        sql`${task.status}<>'pending'`,
        isNull(task.consumedAt),
      ),
    )
    .orderBy(task.invocationKey)
    .catch(rethrowQueryFailure);
  return rows.map((row) => ({
    ...row.branch_context,
    taskId: row.id,
    invocationKey: row.invocation_key,
    nodeId: row.node_id,
    status: row.status,
  }));
}
