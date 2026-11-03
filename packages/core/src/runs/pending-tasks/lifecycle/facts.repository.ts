import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nodeRuns, pendingRunTasks } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { PendingTaskOutcome } from '@pertexo/workflow-engine';
import { wakeTaskAncestors } from '../responses/respond.repository.js';
import { expireDueTasks } from './expire.repository.js';

/** Expiry is resolved first; the existing due-node scanner supplies wakeups. */
export async function readPendingTaskFacts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<readonly PendingTaskOutcome[]> {
  const db = drizzle(client),
    task = pendingRunTasks,
    node = nodeRuns;
  const expired = await expireDueTasks(client, workspaceId, runId);
  if (expired > 0) await wakeTaskAncestors(client, workspaceId, runId);
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
