import type { PoolClient } from 'pg';
import type { PendingTaskOutcome } from '@pertexo/workflow-engine';
import { wakeTaskAncestors } from '../responses/respond.repository.js';

/** Database time resolves expiry; the existing due-node scanner supplies wakeups. */
export async function readPendingTaskFacts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<readonly PendingTaskOutcome[]> {
  const expired = await client.query(
    `update app.pending_run_tasks task set status='expired',completed_at=clock_timestamp()
    from app.workflow_runs run where task.workspace_id=$1 and task.run_id=$2 and task.status='pending' and task.expires_at<=clock_timestamp()
      and run.workspace_id=task.workspace_id and run.id=task.run_id and run.status in ('queued','running','waiting') and run.cancel_requested_at is null`,
    [workspaceId, runId],
  );
  if ((expired.rowCount ?? 0) > 0)
    await wakeTaskAncestors(client, workspaceId, runId);
  const rows = await client.query<{
    id: string;
    invocation_key: string;
    node_id: string;
    status: PendingTaskOutcome['status'];
    branch_context: Pick<PendingTaskOutcome, 'branchPath' | 'iterationPath'>;
  }>(
    `select task.id,task.invocation_key,task.status,node.node_id,node.branch_context from app.pending_run_tasks task join app.node_runs node on node.workspace_id=task.workspace_id and node.id=task.node_run_id and node.workflow_run_id=task.run_id and node.invocation_key=task.invocation_key where task.workspace_id=$1 and task.run_id=$2 and task.status<>'pending' and task.consumed_at is null order by task.invocation_key`,
    [workspaceId, runId],
  );
  return rows.rows.map((row) => ({
    ...row.branch_context,
    taskId: row.id,
    invocationKey: row.invocation_key,
    nodeId: row.node_id,
    status: row.status,
  }));
}
